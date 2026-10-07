// Words for the bench scenario's names (task 23): household nouns and adjectives in English and
// Egyptian Arabic, so the 10,000 things read like an inventory and exercise search the way real
// names do (D42: harakat, the ال prefix, alef forms and taa marbuta in the Arabic ones).

export const EN_NOUNS = [
  'HDMI cable',
  'USB-C cable',
  'phone charger',
  'laptop charger',
  'extension cord',
  'power strip',
  'drill',
  'screwdriver',
  'hammer',
  'tape measure',
  'spirit level',
  'wrench',
  'pliers',
  'paint roller',
  'paintbrush',
  'kettle',
  'toaster',
  'blender',
  'hair dryer',
  'iron',
  'vacuum cleaner',
  'fan',
  'heater',
  'lamp',
  'torch',
  'lantern',
  'router',
  'keyboard',
  'mouse',
  'monitor',
  'headphones',
  'speaker',
  'camera',
  'tripod',
  'backpack',
  'suitcase',
  'umbrella',
  'raincoat',
  'scarf',
  'blanket',
  'pillow',
  'towel',
  'bedsheet',
  'board game',
  'puzzle',
  'football',
  'tennis racket',
  'bicycle pump',
  'first aid kit',
  'thermometer',
  'batteries',
  'light bulbs',
  'candles',
  'picture frame',
  'vase',
  'cookbook',
  'notebook',
  'stapler',
  'scissors',
  'glue gun',
] as const;

export const EN_ADJECTIVES = [
  'black',
  'white',
  'grey',
  'blue',
  'red',
  'green',
  'old',
  'new',
  'spare',
  'small',
  'large',
  'travel',
  'kids',
  'winter',
  'summer',
  'wireless',
  'broken',
  'borrowed',
  'second',
  'folding',
] as const;

export const AR_NOUNS = [
  'كابل HDMI',
  'شاحن',
  'شاحن لابتوب',
  'وصلة كهرباء',
  'مِفَكّ',
  'شاكوش',
  'مِثْقاب',
  'مفتاح إنجليزي',
  'زَرَدِيّة',
  'متر قياس',
  'غلّاية',
  'محمصة',
  'خلّاط',
  'مجفف شعر',
  'مِكْواة',
  'مكنسة كهربائية',
  'مروحة',
  'دفّاية',
  'أباجورة',
  'كشّاف',
  'فانوس',
  'راوتر',
  'لوحة مفاتيح',
  'سمّاعات',
  'كاميرا',
  'حقيبة ظهر',
  'شنطة سفر',
  'شمسية',
  'كوفية',
  'بطّانية',
  'مخدّة',
  'فوطة',
  'مِلاية',
  'لعبة',
  'بازل',
  'كرة قدم',
  'منفاخ',
  'صندوق إسعافات',
  'ترمومتر',
  'بطاريات',
  'لمبات',
  'شموع',
  'برواز',
  'فازة',
  'كتاب طبخ',
  'دفتر',
  'دبّاسة',
  'مقصّ',
  'مسدس شمع',
  'سجّادة صلاة',
] as const;

export const AR_ADJECTIVES = [
  'أسود',
  'أبيض',
  'رمادي',
  'أزرق',
  'أحمر',
  'أخضر',
  'قديم',
  'جديد',
  'احتياطي',
  'صغير',
  'كبير',
  'للسفر',
  'الأطفال',
  'الشتوي',
  'الصيفي',
  'لاسلكي',
  'مكسور',
  'مُسْتَعار',
] as const;

export const BENCH_BRANDS = [
  'Samsung',
  'Bosch',
  'Philips',
  'Sony',
  'Lenovo',
  'IKEA',
  'Anker',
  'Toshiba',
  'توشيبا',
  'فريش',
] as const;

export const BENCH_TAGS = [
  'cables',
  'tools',
  'kitchen',
  'kids',
  'winter',
  'travel',
  'office',
  'garden',
  'أدوات',
  'مطبخ',
  'رمضان',
  'سفر',
] as const;

export const ROOM_NAMES = [
  'Living room',
  'Kitchen',
  'Bedroom',
  'Office',
  'Guest room',
  'Hallway',
  'Basement',
] as const;

/** A small deterministic PRNG (mulberry32): the same seed makes the same inventory. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rand: () => number, list: readonly T[]): T =>
  list[Math.floor(rand() * list.length)] as T;

/** A thing's name: 30% Arabic (noun then adjective), 70% English (adjective then noun). */
export function thingName(rand: () => number): string {
  if (rand() < 0.3) return `${pick(rand, AR_NOUNS)} ${pick(rand, AR_ADJECTIVES)}`;
  const adjective = pick(rand, EN_ADJECTIVES);
  const noun = pick(rand, EN_NOUNS);
  return `${adjective[0]?.toUpperCase()}${adjective.slice(1)} ${noun}`;
}
