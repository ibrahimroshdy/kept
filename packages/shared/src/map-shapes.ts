/**
 * Which shape a thing gets on the location map (1.x, D249): suggestions ranked from its type
 * first, then its name, in Kept's five languages, with a confidence; the picker's groups; and
 * search over shape names and their synonyms. Pure, so the web, the docs' Try the map and the
 * tests share one copy.
 *
 * - **The type** is the thing's built-in type (`tv_display`), its category (the built-in parent,
 *   `electronics`) and a custom type's own name ("Television").
 * - **The name** is read word by word against SHAPE_WORDS: whole words, a simple plural, and in
 *   long words the end of a compound ("Flachbildfernseher" ends in "fernseher"). A phrase inside
 *   a longer phrase that also matched doesn't count ("TV" in "TV stand").
 * - **Confident** means Kept may give the shape by itself: a type that names one shape (a TV, a
 *   car, a bicycle, a box), or a name whose words point at exactly one shape, with nothing in the
 *   other pointing elsewhere. A stand-in (the small device for a webcam) is never confident: it is
 *   suggested first, and its size is a gadget's, not a box's.
 *
 * Auto layout (layout.ts) keeps `guessModel` in map.ts, so nothing already drawn changes shape.
 */
import { MAP_MODEL_KEYS, type MapModelKey } from './map.js';

export const SHAPE_GROUPS = [
  'furniture',
  'storage',
  'electronics',
  'kitchen',
  'tools',
  'outdoor',
  'vehicles',
  'building',
  'other',
] as const;
export type ShapeGroup = (typeof SHAPE_GROUPS)[number];

/** Each shape's group in the picker's "All shapes". */
export const SHAPE_GROUP: Readonly<Record<MapModelKey, ShapeGroup>> = {
  sofa: 'furniture',
  armchair: 'furniture',
  coffee_table: 'furniture',
  tv_stand: 'furniture',
  cube_shelf: 'storage',
  tall_plant: 'outdoor',
  plant: 'outdoor',
  succulent: 'outdoor',
  dining_chair: 'furniture',
  drawers: 'storage',
  bedside: 'furniture',
  metal_shelf: 'storage',
  tool_cart: 'tools',
  drill: 'tools',
  cardboard: 'storage',
  crate: 'storage',
  basket: 'storage',
  outdoor_set: 'outdoor',
  monobloc: 'outdoor',
  planter: 'outdoor',
  planter_long: 'outdoor',
  ac_unit: 'outdoor',
  watering_can: 'outdoor',
  tv: 'electronics',
  bookshelf: 'storage',
  lamp: 'furniture',
  counter: 'kitchen',
  sink: 'kitchen',
  fridge: 'kitchen',
  coffee_machine: 'kitchen',
  microwave: 'kitchen',
  dining: 'furniture',
  bed: 'furniture',
  wardrobe: 'storage',
  table_lamp: 'furniture',
  desk: 'furniture',
  monitor: 'electronics',
  laptop: 'electronics',
  device: 'electronics',
  chair: 'furniture',
  cabinet: 'storage',
  box: 'storage',
  washer: 'kitchen',
  workbench: 'tools',
  tool_wall: 'tools',
  car: 'vehicles',
  bike: 'vehicles',
  water_tank: 'outdoor',
  dish: 'outdoor',
  stairs: 'building',
  stairwell: 'building',
  zone: 'building',
  item: 'other',
};

/** Shapes that stand in for many things: suggested, never given by themselves. */
const STAND_INS: ReadonlySet<MapModelKey> = new Set(['device', 'item']);

/**
 * Words for each shape, in English, French, German, Italian and Arabic (written as people type
 * them; accents, Arabic vowel marks and letter forms are folded by `foldText`). Search finds a
 * shape by these too.
 */
export const SHAPE_WORDS: Readonly<Record<MapModelKey, readonly string[]>> = {
  sofa: ['sofa', 'couch', 'settee', 'canapé', 'divano', 'أريكة', 'كنبة'],
  armchair: [
    'armchair',
    'arm chair',
    'recliner',
    'fauteuil',
    'sessel',
    'poltrona',
    'كرسي بذراعين',
    'فوتيه',
  ],
  coffee_table: [
    'coffee table',
    'table basse',
    'couchtisch',
    'wohnzimmertisch',
    'tavolino',
    'طاولة قهوة',
  ],
  tv_stand: [
    'tv stand',
    'tv unit',
    'tv cabinet',
    'media unit',
    'media console',
    'sideboard',
    'lowboard',
    'meuble tv',
    'buffet',
    'tv möbel',
    'mobile tv',
    'credenza',
    'حامل تلفاز',
    'طاولة تلفزيون',
    'وحدة تلفزيون',
  ],
  cube_shelf: [
    'cube shelf',
    'display shelf',
    'kallax',
    'étagère à cases',
    'würfelregal',
    'libreria a cubi',
    'رف مكعبات',
  ],
  tall_plant: [
    'tall plant',
    'tree',
    'fig',
    'ficus',
    'palm',
    'monstera',
    'grande plante',
    'arbre',
    'palmier',
    'hohe pflanze',
    'baum',
    'palme',
    'pianta alta',
    'albero',
    'palma',
    'نبتة طويلة',
    'شجرة',
    'نخلة',
  ],
  plant: [
    'plant',
    'houseplant',
    'plante',
    'pflanze',
    'zimmerpflanze',
    'pianta',
    'نبتة',
    'نبات',
    'زرع',
  ],
  succulent: [
    'succulent',
    'cactus',
    'aloe',
    'plante grasse',
    'kaktus',
    'sukkulente',
    'pianta grassa',
    'صبار',
    'نبتة عصارية',
  ],
  dining_chair: [
    'chair',
    'dining chair',
    'kitchen chair',
    'stool',
    'chaise',
    'tabouret',
    'stuhl',
    'esszimmerstuhl',
    'hocker',
    'sedia',
    'sgabello',
    'كرسي',
    'كرسي سفرة',
  ],
  drawers: [
    'drawers',
    'chest of drawers',
    'dresser',
    'commode',
    'kommode',
    'cassettiera',
    'خزانة أدراج',
    'أدراج',
  ],
  bedside: [
    'bedside table',
    'bedside',
    'nightstand',
    'night stand',
    'table de chevet',
    'chevet',
    'nachttisch',
    'comodino',
    'طاولة جانب السرير',
    'كومودينو',
  ],
  metal_shelf: [
    'shelf',
    'shelves',
    'shelving',
    'rack',
    'metal shelf',
    'étagère',
    'étagère métallique',
    'regal',
    'metallregal',
    'scaffale',
    'رف',
    'رفوف',
    'رف معدني',
  ],
  tool_cart: [
    'tool cart',
    'tool trolley',
    'tool chest',
    'servante',
    'werkzeugwagen',
    'carrello portautensili',
    'عربة أدوات',
  ],
  drill: [
    'drill',
    'driver',
    'impact driver',
    'perceuse',
    'visseuse',
    'bohrmaschine',
    'akkuschrauber',
    'bohrer',
    'trapano',
    'avvitatore',
    'مثقاب',
    'شنيور',
    'دريل',
  ],
  cardboard: [
    'moving box',
    'carton',
    'cardboard',
    'cardboard box',
    'carton de déménagement',
    'umzugskarton',
    'karton',
    'scatolone',
    'صندوق نقل',
    'كرتونة',
    'كرتون',
  ],
  crate: ['crate', 'bin', 'tub', 'caisse', 'bac', 'kiste', 'cassetta', 'صندوق بلاستيكي'],
  basket: ['basket', 'hamper', 'panier', 'korb', 'cesto', 'cestino', 'سلة'],
  outdoor_set: [
    'bistro set',
    'patio set',
    'garden set',
    'ensemble bistrot',
    'salon de jardin',
    'gartenmöbel',
    'set bistrot',
    'طقم طاولة وكراسي',
    'طقم حديقة',
  ],
  monobloc: [
    'plastic chair',
    'garden chair',
    'chaise en plastique',
    'chaise de jardin',
    'plastikstuhl',
    'gartenstuhl',
    'sedia di plastica',
    'sedia da giardino',
    'كرسي بلاستيكي',
  ],
  planter: [
    'planter',
    'flower box',
    'window box',
    'jardinière',
    'pflanzkasten',
    'blumenkasten',
    'fioriera',
    'حوض زرع',
  ],
  planter_long: [
    'long planter',
    'raised bed',
    'longue jardinière',
    'hochbeet',
    'fioriera lunga',
    'حوض زرع طويل',
  ],
  ac_unit: [
    'ac',
    'a/c',
    'air con',
    'aircon',
    'air conditioner',
    'air conditioning',
    'condenser',
    'climatiseur',
    'clim',
    'climatisation',
    'klimaanlage',
    'klimagerät',
    'condizionatore',
    'climatizzatore',
    'مكيف',
    'تكييف',
  ],
  watering_can: ['watering can', 'arrosoir', 'gießkanne', 'annaffiatoio', 'مرشة'],
  tv: [
    'tv',
    'television',
    'telly',
    'smart tv',
    'téléviseur',
    'télévision',
    'télé',
    'fernseher',
    'fernsehgerät',
    'fernsehen',
    'televisore',
    'televisione',
    'تلفزيون',
    'تلفاز',
    'تليفزيون',
    'screen',
    'écran',
    'bildschirm',
    'schermo',
    'شاشة',
  ],
  bookshelf: [
    'bookshelf',
    'bookcase',
    'bibliothèque',
    'bücherregal',
    'libreria',
    'مكتبة',
    'مكتبة كتب',
  ],
  lamp: [
    'lamp',
    'floor lamp',
    'standard lamp',
    'lampadaire',
    'lampe',
    'stehlampe',
    'lampada',
    'lampada da terra',
    'piantana',
    'مصباح',
    'مصباح أرضي',
    'لمبة',
  ],
  counter: [
    'counter',
    'countertop',
    'worktop',
    'kitchen counter',
    'kitchen unit',
    'plan de travail',
    'comptoir',
    'arbeitsplatte',
    'küchenzeile',
    'theke',
    'piano di lavoro',
    'bancone',
    'سطح مطبخ',
    'كاونتر',
  ],
  sink: [
    'sink',
    'sink counter',
    'évier',
    'meuble évier',
    'spüle',
    'spülbecken',
    'lavello',
    'lavandino',
    'حوض',
    'حوض مطبخ',
    'سطح بحوض',
  ],
  fridge: [
    'fridge',
    'refrigerator',
    'freezer',
    'frigo',
    'réfrigérateur',
    'congélateur',
    'kühlschrank',
    'gefrierschrank',
    'gefriertruhe',
    'frigorifero',
    'congelatore',
    'ثلاجة',
    'فريزر',
    'مجمد',
  ],
  coffee_machine: [
    'coffee machine',
    'coffee maker',
    'espresso',
    'espresso machine',
    'nespresso',
    'kettle',
    'machine à café',
    'cafetière',
    'bouilloire',
    'kaffeemaschine',
    'kaffeevollautomat',
    'wasserkocher',
    'macchina da caffè',
    'macchinetta',
    'bollitore',
    'آلة قهوة',
    'ماكينة قهوة',
    'غلاية',
  ],
  microwave: [
    'microwave',
    'oven',
    'air fryer',
    'toaster',
    'micro ondes',
    'grille pain',
    'mikrowelle',
    'ofen',
    'backofen',
    'toaster',
    'microonde',
    'forno',
    'tostapane',
    'ميكروويف',
    'فرن',
    'قلاية هوائية',
    'محمصة',
  ],
  dining: [
    'table',
    'dining table',
    'kitchen table',
    'table à manger',
    'tisch',
    'esstisch',
    'küchentisch',
    'tavolo',
    'tavolo da pranzo',
    'طاولة',
    'طاولة سفرة',
    'سفرة',
    'ترابيزة',
  ],
  bed: ['bed', 'cot', 'crib', 'lit', 'bett', 'letto', 'culla', 'سرير'],
  wardrobe: [
    'wardrobe',
    'closet',
    'cupboard',
    'pantry',
    'armoire',
    'placard',
    'penderie',
    'schrank',
    'kleiderschrank',
    'armadio',
    'خزانة',
    'دولاب',
    'خزانة ملابس',
  ],
  table_lamp: [
    'table lamp',
    'desk lamp',
    'bedside lamp',
    'lampe de table',
    'lampe de chevet',
    'lampe de bureau',
    'tischlampe',
    'schreibtischlampe',
    'nachttischlampe',
    'lampada da tavolo',
    'abat jour',
    'مصباح طاولة',
    'أباجورة',
  ],
  desk: ['desk', 'bureau', 'schreibtisch', 'scrivania', 'مكتب'],
  monitor: [
    'monitor',
    'screen',
    'display',
    'écran',
    'moniteur',
    'bildschirm',
    'schermo',
    'شاشة',
    'شاشة كمبيوتر',
  ],
  laptop: [
    'laptop',
    'notebook',
    'macbook',
    'chromebook',
    'ordinateur portable',
    'pc portable',
    'portatile',
    'computer portatile',
    'حاسوب محمول',
    'لابتوب',
    'لاب توب',
  ],
  device: [
    'webcam',
    'web cam',
    'camera',
    'router',
    'modem',
    'access point',
    'hub',
    'speaker',
    'smart speaker',
    'soundbar',
    'console',
    'playstation',
    'ps5',
    'ps4',
    'xbox',
    'nintendo',
    'phone',
    'smartphone',
    'iphone',
    'tablet',
    'ipad',
    'kindle',
    'printer',
    'hard drive',
    'nas',
    'raspberry pi',
    'headphones',
    'remote',
    'controller',
    'charger',
    'power bank',
    'doorbell',
    'thermostat',
    'smoke detector',
    'caméra',
    'appareil photo',
    'routeur',
    'box internet',
    'enceinte',
    'haut parleur',
    'téléphone',
    'tablette',
    'imprimante',
    'disque dur',
    'casque',
    'manette',
    'télécommande',
    'chargeur',
    'kamera',
    'lautsprecher',
    'konsole',
    'handy',
    'telefon',
    'drucker',
    'festplatte',
    'kopfhörer',
    'fernbedienung',
    'ladegerät',
    'rauchmelder',
    'telecamera',
    'fotocamera',
    'cassa',
    'altoparlante',
    'telefono',
    'cellulare',
    'stampante',
    'cuffie',
    'telecomando',
    'caricatore',
    'كاميرا',
    'ويب كام',
    'راوتر',
    'مودم',
    'سماعة',
    'سماعات',
    'مكبر صوت',
    'بلايستيشن',
    'هاتف',
    'موبايل',
    'جوال',
    'تابلت',
    'طابعة',
    'ريموت',
    'يد تحكم',
    'شاحن',
  ],
  chair: [
    'desk chair',
    'office chair',
    'gaming chair',
    'chaise de bureau',
    'fauteuil de bureau',
    'bürostuhl',
    'schreibtischstuhl',
    'sedia da ufficio',
    'كرسي مكتب',
  ],
  cabinet: [
    'cabinet',
    'filing cabinet',
    'file cabinet',
    'safe',
    'classeur',
    'coffre fort',
    'aktenschrank',
    'tresor',
    'schedario',
    'cassaforte',
    'خزانة ملفات',
    'خزنة',
  ],
  box: [
    'box',
    'storage box',
    'boîte',
    'boîte de rangement',
    'aufbewahrungsbox',
    'schachtel',
    'box',
    'scatola',
    'contenitore',
    'صندوق',
    'صندوق تخزين',
    'علبة',
  ],
  washer: [
    'washing machine',
    'washer',
    'dryer',
    'tumble dryer',
    'dishwasher',
    'lave linge',
    'sèche linge',
    'lave vaisselle',
    'waschmaschine',
    'trockner',
    'geschirrspüler',
    'spülmaschine',
    'lavatrice',
    'asciugatrice',
    'lavastoviglie',
    'غسالة',
    'غسالة صحون',
    'مجفف',
    'نشافة',
  ],
  workbench: ['workbench', 'work bench', 'établi', 'werkbank', 'banco da lavoro', 'طاولة عمل'],
  tool_wall: [
    'tool wall',
    'pegboard',
    'panneau à outils',
    'werkzeugwand',
    'lochwand',
    'parete attrezzi',
    'جدار الأدوات',
  ],
  car: [
    'car',
    'van',
    'truck',
    'suv',
    'pickup',
    'voiture',
    'camionnette',
    'auto',
    'pkw',
    'wagen',
    'automobile',
    'furgone',
    'سيارة',
    'عربية',
    'شاحنة',
  ],
  bike: [
    'bike',
    'bicycle',
    'ebike',
    'e bike',
    'scooter',
    'motorbike',
    'motorcycle',
    'vélo',
    'bicyclette',
    'moto',
    'fahrrad',
    'motorrad',
    'roller',
    'bicicletta',
    'bici',
    'motorino',
    'دراجة',
    'عجلة',
    'موتوسيكل',
    'دراجة نارية',
  ],
  water_tank: [
    'water tank',
    'tank',
    'cistern',
    'citerne',
    'réservoir',
    'wassertank',
    'zisterne',
    'serbatoio',
    'cisterna',
    'خزان',
    'خزان مياه',
  ],
  dish: [
    'satellite dish',
    'dish',
    'satellite',
    'parabole',
    'antenne parabolique',
    'satellitenschüssel',
    'parabolantenne',
    'parabola',
    'طبق',
    'دش',
    'طبق استقبال',
  ],
  stairs: ['stairs', 'stair', 'staircase', 'escalier', 'treppe', 'scala', 'درج', 'سلم'],
  stairwell: ['stairwell', 'cage d escalier', 'treppenhaus', 'vano scale', 'بئر الدرج'],
  zone: ['area', 'corner', 'zone', 'bereich', 'ecke', 'angolo', 'منطقة', 'ركن', 'زاوية'],
  item: [
    'small thing',
    'thing',
    'petit objet',
    'objet',
    'kleines ding',
    'ding',
    'cosa piccola',
    'oggetto',
    'شيء صغير',
    'شيء',
  ],
};

/** What a built-in type says about its shape: the shapes, best first, and how sure. */
type TypeHint = { shapes: readonly MapModelKey[]; score: number };

/**
 * Built-in types (packages/shared/src/builtin-types.ts) by key. A score of 0.9 or more names the
 * thing's shape (a TV is drawn as a TV); lower ones only rank the picker's suggestions.
 */
const TYPE_SHAPES: Readonly<Record<string, TypeHint>> = {
  tv_display: { shapes: ['tv', 'monitor'], score: 0.95 },
  car: { shapes: ['car'], score: 0.95 },
  bicycle: { shapes: ['bike'], score: 0.95 },
  motorbike: { shapes: ['bike'], score: 0.9 },
  box_bin: { shapes: ['box', 'crate', 'cardboard', 'basket'], score: 0.9 },
  vehicle: { shapes: ['car', 'bike'], score: 0.6 },
  computer: { shapes: ['laptop', 'monitor', 'device'], score: 0.7 },
  phone: { shapes: ['device'], score: 0.7 },
  tablet: { shapes: ['device'], score: 0.7 },
  network_device: { shapes: ['device'], score: 0.7 },
  camera: { shapes: ['device'], score: 0.7 },
  console: { shapes: ['device'], score: 0.7 },
  device: { shapes: ['device', 'item'], score: 0.6 },
  smoke_detector: { shapes: ['device'], score: 0.6 },
  charger: { shapes: ['device', 'item'], score: 0.5 },
  large_appliance: { shapes: ['fridge', 'washer'], score: 0.6 },
  small_appliance: { shapes: ['microwave', 'coffee_machine', 'device'], score: 0.6 },
  power_tool: { shapes: ['drill', 'tool_cart'], score: 0.7 },
  tool: { shapes: ['drill', 'tool_cart', 'workbench', 'tool_wall'], score: 0.4 },
  safe: { shapes: ['cabinet'], score: 0.7 },
  generator: { shapes: ['ac_unit'], score: 0.6 },
  furniture: {
    shapes: ['sofa', 'armchair', 'dining', 'desk', 'drawers', 'wardrobe', 'bookshelf', 'cabinet'],
    score: 0.4,
  },
  appliance: { shapes: ['fridge', 'washer', 'microwave', 'coffee_machine'], score: 0.4 },
  electronics: { shapes: ['tv', 'monitor', 'laptop', 'device'], score: 0.4 },
  consumables: { shapes: ['box', 'basket', 'item'], score: 0.3 },
  batteries: { shapes: ['box', 'item'], score: 0.3 },
  filters: { shapes: ['box', 'item'], score: 0.3 },
};

/** Folds text for matching: lower case, no accents, ß as ss, Arabic letter forms and vowel
 * marks folded, punctuation as spaces. */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ـ/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A folded word without the Arabic article (الشاشة → شاشه, والتلفاز → تلفاز). */
const bare = (w: string): string => {
  if (/^(وال|بال|فال|كال)/.test(w) && w.length > 5) return w.slice(3);
  if (w.startsWith('ال') && w.length > 3) return w.slice(2);
  if (w.startsWith('لل') && w.length > 4) return w.slice(2);
  return w;
};

const words = (text: string): string[] => foldText(text).split(' ').filter(Boolean).map(bare);

/** How a name's word meets a shape's word: 2 the same (or a simple plural), 1 the end of a
 * compound of seven letters or more ("Flachbildfernseher"; "controller" doesn't end in a German
 * scooter), 0 not at all. */
function wordMatch(word: string, term: string): 0 | 1 | 2 {
  if (word === term) return 2;
  if (word.startsWith(term) && word.length - term.length <= 2) {
    const tail = word.slice(term.length);
    if (term.length >= 3 && (tail === 's' || tail === 'es')) return 2;
    if (term.length >= 4 && ['e', 'n', 'en', 'er', 'i'].includes(tail)) return 2;
  }
  if (term.length >= 7 && word.length > term.length && word.endsWith(term)) return 1;
  return 0;
}

type Phrase = { model: MapModelKey; terms: string[] };
const PHRASES: readonly Phrase[] = MAP_MODEL_KEYS.flatMap((model) =>
  SHAPE_WORDS[model].map((w) => ({ model, terms: words(w) })).filter((p) => p.terms.length > 0),
);

type Hit = { model: MapModelKey; start: number; end: number; exact: boolean };

/** The shapes a text's words point at: phrases inside a longer matched phrase are dropped. */
function hitsIn(text: string): Hit[] {
  const ws = words(text);
  const hits: Hit[] = [];
  for (const p of PHRASES) {
    const n = p.terms.length;
    for (let i = 0; i + n <= ws.length; i++) {
      let exact = true;
      let ok = true;
      for (let j = 0; j < n; j++) {
        const m = wordMatch(ws[i + j] as string, p.terms[j] as string);
        if (m === 0 || (m === 1 && j < n - 1)) {
          ok = false;
          break;
        }
        if (m === 1) exact = false;
      }
      if (ok) hits.push({ model: p.model, start: i, end: i + n, exact });
    }
  }
  return hits.filter(
    (h) =>
      !hits.some(
        (o) =>
          o !== h &&
          o.model !== h.model &&
          o.start <= h.start &&
          o.end >= h.end &&
          o.end - o.start > h.end - h.start,
      ),
  );
}

/** Each shape a text points at, with a score: 0.9 for whole words (0.95 for a phrase of two or
 * more), 0.6 for the end of a compound. */
function nameScores(text: string | null | undefined): Map<MapModelKey, number> {
  const out = new Map<MapModelKey, number>();
  if (!text) return out;
  for (const h of hitsIn(text)) {
    const s = h.exact ? (h.end - h.start > 1 ? 0.95 : 0.9) : 0.6;
    out.set(h.model, Math.max(out.get(h.model) ?? 0, s));
  }
  return out;
}

export type ShapeInput = {
  name: string | null;
  /** The thing's built-in type key, its own or its nearest built-in ancestor's. */
  typeKey?: string | null;
  /** A custom type's own name ("Television"); built-in types have none. */
  typeName?: string | null;
  isContainer?: boolean;
};

export type ShapeFrom = 'type' | 'name' | 'guess';

export type ShapeSuggestion = {
  model: MapModelKey;
  /** 0–1: how well the type and name fit this shape. */
  score: number;
  /** Where it came from: the type, the name, or neither (a fallback). */
  from: ShapeFrom;
};

export type ShapeSuggestions = {
  /** Best first, at least three and at most `limit`. */
  shapes: ShapeSuggestion[];
  /** The first is clear enough for Kept to give it by itself. */
  confident: boolean;
};

const CONFIDENT_TYPE = 0.9;

/** The fallbacks after everything that matched: storage for a container, else small shapes. */
function fallbacks(input: ShapeInput, electronic: boolean): MapModelKey[] {
  if (input.isContainer) return ['box', 'cardboard', 'crate', 'basket'];
  return electronic ? ['device', 'item', 'box'] : ['item', 'device', 'box'];
}

/**
 * Ranks shapes for a thing from its type first, then its name. The first is the shape the thing
 * gets when it is put on the map; `confident` says Kept may say so ("from its type") rather than
 * ask.
 */
export function suggestShapes(input: ShapeInput, limit = 6): ShapeSuggestions {
  const scores = new Map<MapModelKey, { type: number; name: number }>();
  const at = (m: MapModelKey) => {
    let s = scores.get(m);
    if (!s) {
      s = { type: 0, name: 0 };
      scores.set(m, s);
    }
    return s;
  };
  const hint = input.typeKey ? TYPE_SHAPES[input.typeKey] : undefined;
  /** Shapes the type names outright: a confident type's first shape, or a custom type's name. */
  const typeNames = new Set<MapModelKey>();
  hint?.shapes.forEach((m, i) => {
    const s = at(m);
    s.type = Math.max(s.type, hint.score - i * 0.05);
    if (i === 0 && hint.score >= CONFIDENT_TYPE) typeNames.add(m);
  });
  // A custom type's name is the type speaking: "Television" is as clear as the TV type.
  for (const [m, v] of nameScores(input.typeName)) {
    const s = at(m);
    s.type = Math.max(s.type, v >= 0.9 ? 0.92 : v);
    if (v >= 0.9) typeNames.add(m);
  }
  const fromName = nameScores(input.name);
  for (const [m, v] of fromName) at(m).name = v;

  // Both pointing at a shape lifts it above either alone (a TV-type thing named "Monitor" ranks
  // the monitor first); the score shown is capped at 1.
  const raw = (s: { type: number; name: number }) =>
    Math.max(s.type, s.name) + 0.1 * Math.min(s.type, s.name);
  const ranked: ShapeSuggestion[] = [...scores.entries()]
    .sort(
      ([a, sa], [b, sb]) =>
        raw(sb) - raw(sa) || MAP_MODEL_KEYS.indexOf(a) - MAP_MODEL_KEYS.indexOf(b),
    )
    .map(([model, s]) => ({
      model,
      score: Math.round(Math.min(1, raw(s)) * 100) / 100,
      from: typeNames.has(model) || s.type > s.name ? 'type' : 'name',
    }));

  // What the name's whole words point at, stand-ins left out.
  const named = [...fromName.entries()]
    .filter(([m, v]) => v >= 0.9 && !STAND_INS.has(m))
    .map(([m]) => m);
  const top = ranked[0];
  const confident =
    !!top &&
    !STAND_INS.has(top.model) &&
    ((typeNames.has(top.model) && (named.length === 0 || named.includes(top.model))) ||
      (named.length === 1 &&
        named[0] === top.model &&
        (typeNames.size === 0 || typeNames.has(top.model))));

  const electronic =
    input.typeKey === 'electronics' ||
    ranked.some((r) => r.model === 'device' || SHAPE_GROUP[r.model] === 'electronics');
  const shapes = ranked.slice(0, limit);
  for (const m of fallbacks(input, electronic)) {
    if (shapes.length >= Math.max(3, Math.min(limit, ranked.length))) break;
    if (!shapes.some((x) => x.model === m)) shapes.push({ model: m, score: 0, from: 'guess' });
  }
  while (shapes.length < 3) {
    const m = MAP_MODEL_KEYS.find((k) => !shapes.some((x) => x.model === k)) as MapModelKey;
    shapes.push({ model: m, score: 0, from: 'guess' });
  }
  return { shapes: shapes.slice(0, Math.max(3, limit)), confident };
}

/**
 * The shape a thing gets when it is put on the map: the one someone already chose for it (never
 * replaced), else the first suggestion. `from` says why: `chosen`, `type` or `name` when Kept is
 * confident, `guess` when it isn't (the picker then shows the suggestions).
 */
export function shapeOnAdd(
  input: ShapeInput,
  chosen: MapModelKey | null = null,
): { model: MapModelKey; from: ShapeFrom | 'chosen' } {
  if (chosen) return { model: chosen, from: 'chosen' };
  const { shapes, confident } = suggestShapes(input);
  const first = shapes[0] as ShapeSuggestion;
  return { model: first.model, from: confident ? first.from : 'guess' };
}

/**
 * Shapes whose name (in the reader's language, `names`) or words in any of the five languages
 * match a search, best first: a name that starts with it, a name that has it, a word that starts
 * with it, a word that has it. An empty search is every shape, in the catalogue's order.
 */
export function searchShapes(
  query: string,
  names: Readonly<Partial<Record<MapModelKey, string>>> = {},
): MapModelKey[] {
  const q = words(query).join(' ');
  if (!q) return [...MAP_MODEL_KEYS];
  const rank = (m: MapModelKey): number => {
    const own = words(names[m] ?? '').join(' ');
    if (own.startsWith(q) || own.split(' ').some((w) => w.startsWith(q))) return 4;
    if (own.includes(q)) return 3;
    const ws = SHAPE_WORDS[m].map((w) => words(w).join(' '));
    if (ws.some((w) => w.startsWith(q) || w.split(' ').some((x) => x.startsWith(q)))) return 2;
    if (q.length >= 3 && ws.some((w) => w.includes(q))) return 1;
    if (nameScores(query).has(m)) return 1;
    return 0;
  };
  return MAP_MODEL_KEYS.map((m) => [m, rank(m)] as const)
    .filter(([, r]) => r > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m);
}
