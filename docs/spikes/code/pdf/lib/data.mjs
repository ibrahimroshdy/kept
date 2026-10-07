// The sample report every engine renders: 60 things in 6 places, 30 with a photo.
// All strings (labels, numbers, money, dates) are formatted here with Intl, so every engine gets
// the exact same text and the test is only about layout, shaping and bidi.
import QRCode from 'qrcode';

const here = new URL('..', import.meta.url).pathname;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// [en, ar] pairs. Place paths are arrays of segments.
const PLACES = [
  { path: [['Home', 'البيت'], ['Living room', 'غرفة المعيشة'], ['TV unit', 'وحدة التلفزيون']] },
  { path: [['Home', 'البيت'], ['Kitchen', 'المطبخ'], ['Upper cabinet', 'الدولاب العلوي']] },
  { path: [['Home', 'البيت'], ['Study', 'المكتب'], ['Desk drawer', 'درج المكتب']] },
  { path: [['Home', 'البيت'], ['Garage', 'الجراج'], ['Shelf B', 'الرف B'], ['Box 3', 'صندوق 3']] },
  { path: [['Home', 'البيت'], ['Bedroom', 'غرفة النوم'], ['Wardrobe', 'الدولاب']] },
  { path: [['Storage unit', 'المخزن'], ['Aisle 2', 'الممر 2'], ['Crate 7', 'الصندوق الخشبي 7']] },
];

// name, type, brand, model — the Arabic names deliberately embed Latin brands and numbers
// ("Samsung TV 55" inside Arabic) to test mixed bidi.
const THINGS = [
  [['Samsung TV 55"', 'تلفزيون Samsung TV 55 بوصة'], ['Television', 'تلفزيون'], 'Samsung', 'QA55Q70D'],
  [['Soundbar', 'مكبر صوت Soundbar'], ['Audio', 'صوتيات'], 'Sony', 'HT-S400'],
  [['PlayStation 5', 'جهاز PlayStation 5'], ['Console', 'جهاز ألعاب'], 'Sony', 'CFI-2016'],
  [['Apple TV 4K', 'جهاز Apple TV 4K'], ['Streaming box', 'جهاز بث'], 'Apple', 'A2843'],
  [['HDMI cables (3)', 'كابلات HDMI (٣)'], ['Cable', 'كابل'], 'Belkin', 'AV10168'],
  [['Universal remote', 'ريموت عام'], ['Remote', 'ريموت'], 'Logitech', 'Harmony 665'],
  [['Wi-Fi router', 'راوتر Wi-Fi 6'], ['Network', 'شبكة'], 'TP-Link', 'Archer AX55'],
  [['Blu-ray player', 'مشغل Blu-ray'], ['Player', 'مشغل'], 'LG', 'UBK80'],
  [['Stand mixer', 'عجان KitchenAid'], ['Appliance', 'جهاز منزلي'], 'KitchenAid', '5KSM175PS'],
  [['Espresso machine', 'ماكينة إسبريسو'], ['Appliance', 'جهاز منزلي'], "De'Longhi", 'EC685.M'],
  [['Hand blender', 'خلاط يدوي'], ['Appliance', 'جهاز منزلي'], 'Braun', 'MQ7035X'],
  [['Cast iron pan 28 cm', 'مقلاة حديد زهر ٢٨ سم'], ['Cookware', 'أواني طهي'], 'Lodge', 'L10SK3'],
  [['Knife set', 'طقم سكاكين'], ['Cutlery', 'أدوات مائدة'], 'Victorinox', '5.1150.11'],
  [['Food processor', 'محضر طعام'], ['Appliance', 'جهاز منزلي'], 'Moulinex', 'FP8221'],
  [['Rice cooker', 'حلة أرز كهربائية'], ['Appliance', 'جهاز منزلي'], 'Tefal', 'RK7321'],
  [['Scale', 'ميزان مطبخ'], ['Tool', 'أداة'], 'Salter', '1066'],
  [['Toaster', 'محمصة خبز'], ['Appliance', 'جهاز منزلي'], 'Philips', 'HD2581'],
  [['Kettle', 'غلاية'], ['Appliance', 'جهاز منزلي'], 'Bosch', 'TWK8613'],
  [['MacBook Pro 14"', 'لابتوب MacBook Pro 14'], ['Laptop', 'لابتوب'], 'Apple', 'A2992'],
  [['External SSD 2 TB', 'قرص SSD خارجي ٢ تيرابايت'], ['Storage', 'تخزين'], 'Samsung', 'T7 Shield'],
  [['Passport (expired)', 'جواز سفر (منتهي)'], ['Document', 'مستند'], '—', '—'],
  [['Car title', 'رخصة السيارة'], ['Document', 'مستند'], '—', '—'],
  [['Fountain pen', 'قلم حبر'], ['Stationery', 'أدوات مكتبية'], 'Lamy', '2000'],
  [['USB-C hub', 'موزع USB-C'], ['Accessory', 'ملحق'], 'Anker', 'A8346'],
  [['Calculator', 'آلة حاسبة'], ['Tool', 'أداة'], 'Casio', 'fx-991EX'],
  [['Headphones', 'سماعات رأس'], ['Audio', 'صوتيات'], 'Sony', 'WH-1000XM5'],
  [['YubiKey 5C', 'مفتاح YubiKey 5C'], ['Security key', 'مفتاح أمان'], 'Yubico', '5C NFC'],
  [['Watch', 'ساعة يد'], ['Watch', 'ساعة'], 'Casio', 'GW-M5610'],
  [['Cordless drill', 'شنيور لاسلكي'], ['Power tool', 'عدة كهربائية'], 'Bosch', 'GSR 18V-55'],
  [['Socket set 94 pcs', 'طقم لقم ٩٤ قطعة'], ['Hand tool', 'عدة يدوية'], 'Stanley', 'STMT82835'],
  [['Car jack', 'كريك سيارة'], ['Automotive', 'سيارات'], 'Bosch', 'F002'],
  [['Pressure washer', 'غسالة ضغط'], ['Power tool', 'عدة كهربائية'], 'Kärcher', 'K4 Power'],
  [['Extension cord 10 m', 'وصلة كهرباء ١٠ م'], ['Electrical', 'كهرباء'], 'Schneider', 'X10'],
  [['Tyre inflator', 'منفاخ إطارات'], ['Automotive', 'سيارات'], 'Xiaomi', '1S'],
  [['Jump starter', 'جهاز تشغيل البطارية'], ['Automotive', 'سيارات'], 'NOCO', 'GB40'],
  [['Stud finder', 'كاشف معادن'], ['Tool', 'أداة'], 'Bosch', 'UniversalDetect'],
  [['Ladder 3 steps', 'سلم ٣ درجات'], ['Tool', 'أداة'], 'Hailo', '4313-001'],
  [['Winter coat', 'معطف شتوي'], ['Clothing', 'ملابس'], 'Uniqlo', '—'],
  [['Suit, navy', 'بدلة كحلي'], ['Clothing', 'ملابس'], 'Hugo Boss', '—'],
  [['Wedding ring', 'دبلة الزواج'], ['Jewellery', 'مجوهرات'], '—', '—'],
  [['Gold bracelet 21k', 'إسورة ذهب عيار ٢١'], ['Jewellery', 'مجوهرات'], '—', '—'],
  [['Sunglasses', 'نظارة شمس'], ['Accessory', 'ملحق'], 'Ray-Ban', 'RB2140'],
  [['Travel bag', 'شنطة سفر'], ['Luggage', 'حقائب'], 'Samsonite', 'Proxis 55'],
  [['Hair dryer', 'مجفف شعر'], ['Appliance', 'جهاز منزلي'], 'Dyson', 'HD08'],
  [['Perfume', 'عطر'], ['Cosmetics', 'مستحضرات'], 'Chanel', 'Bleu 100 ml'],
  [['Spare bedding set', 'طقم مفارش احتياطي'], ['Textile', 'مفروشات'], 'IKEA', 'Dvala'],
  [['Camping tent', 'خيمة تخييم'], ['Outdoor', 'رحلات'], 'Coleman', 'Sundome 4'],
  [['Sleeping bags (2)', 'أكياس نوم (٢)'], ['Outdoor', 'رحلات'], 'Decathlon', 'Arpenaz 10°'],
  [['Christmas lights', 'إضاءة زينة'], ['Decoration', 'زينة'], 'Philips', '—'],
  [['Ramadan lantern', 'فانوس رمضان'], ['Decoration', 'زينة'], '—', '—'],
  [['Old Nokia phone', 'موبايل Nokia قديم'], ['Phone', 'موبايل'], 'Nokia', '3310'],
  [['Film camera', 'كاميرا فيلم'], ['Camera', 'كاميرا'], 'Canon', 'AE-1'],
  [['Books (box)', 'كتب (صندوق)'], ['Books', 'كتب'], '—', '—'],
  [['Bicycle', 'دراجة'], ['Sport', 'رياضة'], 'Trek', 'FX 2'],
  [['Treadmill', 'مشاية كهربائية'], ['Sport', 'رياضة'], 'Kingsmith', 'R1 Pro'],
  [['Baby stroller', 'عربة أطفال'], ['Baby', 'أطفال'], 'Chicco', 'Bravo'],
  [['Sewing machine', 'ماكينة خياطة'], ['Appliance', 'جهاز منزلي'], 'Singer', '4423'],
  [['Space heater', 'دفاية كهربائية'], ['Appliance', 'جهاز منزلي'], "De'Longhi", 'HFX30C18'],
  [['Portable AC', 'تكييف متنقل'], ['Appliance', 'جهاز منزلي'], 'Midea', 'MPPH-12'],
  [['Arabic keyboard', 'لوحة مفاتيح عربي'], ['Accessory', 'ملحق'], 'Logitech', 'K380'],
];

// A last section every engine renders: the cases where Arabic engines usually break.
export const STRESS = [
  'لا إله — لأن — لإصلاح — لآلة',
  'مُحَمَّد عَلِيّ — كـــتـــاب',
  'جهاز (Wi-Fi 6) جديد، والسعر 1,250.50 EGP!',
  'رقم الموديل: QA55Q70D-XZ/2024 (الإصدار ٢)',
  'اشتريت شاشة Samsung TV 55 بوصة من Carrefour في المعادي بتاريخ 12/03/2024، وتم تمديد الضمان حتى 2027 عن طريق شركة AXA للتأمين، والرقم التسلسلي هو SAZVFMVK1816 كما هو مكتوب على الملصق الخلفي للجهاز.',
  'Receipt from “كارفور المعادي” dated 12 March, warranty (ضمان) 2 years.',
];

const CONDITIONS = [['New', 'جديد'], ['Good', 'جيد'], ['Fair', 'مقبول'], ['Worn', 'مستهلك']];
const CURRENCIES = ['EGP', 'EGP', 'EGP', 'USD', 'EUR'];

const L = {
  en: {
    title: 'Inventory report', location: 'Home — Maadi', account: 'Gordon household',
    generated: 'Generated', things: 'Things', places: 'Places', photos: 'With photos',
    totals: 'Totals by currency', contents: 'Contents', page: 'Page', of: 'of',
    type: 'Type', brand: 'Brand', model: 'Model', serial: 'Serial', condition: 'Condition',
    qty: 'Qty', value: 'Value', subtotal: 'Subtotal', sep: ' › ',
    footer: 'Kept · Inventory report · Home — Maadi', confidential: 'Private — generated for insurance',
    summary: 'Summary', stress: 'Text shaping check',
  },
  ar: {
    title: 'تقرير الجرد', location: 'البيت — المعادي', account: 'عائلة جوردون',
    generated: 'تاريخ الإنشاء', things: 'الأشياء', places: 'الأماكن', photos: 'بصور',
    totals: 'الإجمالي حسب العملة', contents: 'المحتويات', page: 'صفحة', of: 'من',
    type: 'النوع', brand: 'الماركة', model: 'الموديل', serial: 'الرقم التسلسلي', condition: 'الحالة',
    qty: 'الكمية', value: 'القيمة', subtotal: 'الإجمالي الفرعي', sep: ' ‹ ',
    footer: 'Kept · تقرير الجرد · البيت — المعادي', confidential: 'خاص — أُنشئ لأغراض التأمين',
    summary: 'الملخص', stress: 'فحص تشكيل النص',
  },
};

/**
 * @param {'en'|'ar'} lang
 * @param {{digits?: 'latn'|'arab', qr?: boolean, scale?: number}} opts
 *   scale: number of things (default 60 = 6 places x 10). 500 = 25 places x 20, for the budget
 *   run; place names repeat with a number, things cycle, every photo file is unique.
 */
export async function buildReport(lang, opts = {}) {
  const digits = opts.digits ?? (lang === 'ar' ? 'arab' : 'latn');
  const locale = lang === 'ar' ? `ar-EG-u-nu-${digits}` : 'en-GB';
  const i = lang === 'ar' ? 1 : 0;
  const nf = new Intl.NumberFormat(locale);
  const money = (amount, currency) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code' }).format(amount);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date('2026-09-26T09:00:00Z'));
  const r = rng(42);
  const code = () => Array.from({ length: 6 }, () => CROCKFORD[Math.floor(r() * 32)]).join('');

  const places = [];
  let t = 0;
  const grand = new Map();
  let photos = 0;
  const scale = opts.scale ?? 60;
  const perPlace = scale > 60 ? 20 : 10;
  const nPlaces = Math.ceil(scale / perPlace);
  const placeList = Array.from({ length: nPlaces }, (_, n) => {
    const base = PLACES[n % PLACES.length];
    if (n < PLACES.length) return base;
    const rep = Math.floor(n / PLACES.length) + 1;
    return { path: base.path.map((seg, j) => (j === base.path.length - 1 ? [`${seg[0]} (${rep})`, `${seg[1]} (${rep})`] : seg)) };
  });
  for (const [pi, p] of placeList.entries()) {
    const things = [];
    const sub = new Map();
    for (let k = 0; k < perPlace && t < scale; k++, t++) {
      const [name, type, brand, model] = THINGS[t % THINGS.length];
      const currency = CURRENCIES[Math.floor(r() * CURRENCIES.length)];
      const amount = Math.round((currency === 'EGP' ? 800 + r() * 90000 : 20 + r() * 2400) * 100) / 100;
      const qty = r() < 0.15 ? 2 + Math.floor(r() * 3) : 1;
      const shortId = code();
      // Half the things have a photo. In the budget run every third one is a WebP derivative
      // (JPEG_ONLY=1 turns that off, to show what WebP costs: PDFs cannot hold WebP).
      const n = t / 2;
      const ext = scale > 60 && n % 3 === 0 && !process.env.JPEG_ONLY ? 'webp' : 'jpg';
      const photo = t % 2 === 0 ? `${here}sample/thumbs/t${String(n).padStart(3, '0')}.${ext}` : null;
      if (photo) photos++;
      const serial = brand === '—' ? '' : `${brand.slice(0, 2).toUpperCase().replace(/[^A-Z]/g, 'X')}${code()}${Math.floor(r() * 9000 + 1000)}`;
      sub.set(currency, (sub.get(currency) ?? 0) + amount * qty);
      grand.set(currency, (grand.get(currency) ?? 0) + amount * qty);
      const url = `https://kept.example/t/${shortId}`;
      things.push({
        shortId,
        name: name[i],
        type: type[i],
        brand: brand === '—' ? '' : brand,
        model: model === '—' ? '' : model,
        serial,
        condition: CONDITIONS[Math.floor(r() * 4)][i],
        qty: nf.format(qty),
        value: money(amount * qty, currency),
        photo,
        qrSvg: opts.qr ? await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }) : null,
        qrPng: opts.qr ? await QRCode.toDataURL(url, { margin: 0, width: 96, errorCorrectionLevel: 'M' }) : null,
      });
    }
    places.push({
      id: `place-${pi + 1}`,
      path: p.path.map((s) => s[i]),
      pathText: p.path.map((s) => s[i]).join(L[lang].sep),
      count: nf.format(things.length),
      things,
      subtotals: [...sub].map(([c, v]) => money(v, c)),
    });
  }
  return {
    lang,
    dir: lang === 'ar' ? 'rtl' : 'ltr',
    digits,
    labels: L[lang],
    nf: (n) => nf.format(n),
    date,
    counts: { things: nf.format(t), places: nf.format(places.length), photos: nf.format(photos) },
    totals: [...grand].map(([c, v]) => money(v, c)),
    places,
    stress: STRESS,
  };
}
