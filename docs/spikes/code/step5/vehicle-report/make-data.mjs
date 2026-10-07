// SPIKE (step 5, T0, V39). Writes a job directory the way reports/service.ts does for the report
// child (data.json + thumbs/*.jpg), for a vehicle history report with five years of data:
// 60 services with 3 invoice thumbnails each, 600 fills, 860 odometer readings of which 200 carry
// a proof photo, and 10 documents. Strings, numbers, money and dates are formatted here, with
// Intl in the reader's language and digits, as reports/view.ts does: the template formats nothing.
//
//   node make-data.mjs <en|ar> <thumbPx> <outDir> [proofCap]
//
// Thumbnails are JPEG q72 mozjpeg at <thumbPx> square, made with the server's own sharp (the
// report service's settings, THUMB_PX = 200). They are unique images: an ImageMagick plasma with
// gaussian noise and a caption, about the size a phone photo's thumbnail is (needs `magick`).
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../../..');
const require = createRequire(path.join(root, 'apps/server/package.json'));
const sharp = require('sharp');

const [lang = 'en', pxArg = '200', outDir, capArg] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: node make-data.mjs <en|ar> <thumbPx> <outDir> [proofCap]');
  process.exit(2);
}
const px = Number(pxArg);
const proofCap = capArg ? Number(capArg) : null;
const ar = lang === 'ar';
/** SCALE=2 doubles every count (ten years of this car), for headroom. */
const SCALE = Number(process.env.SCALE ?? 1);
const locale = ar ? 'ar-EG' : 'en-GB';

// ---- A deterministic random source, so both languages get the same history.
let seed = 42;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

// ---- Formatters (Intl, the reader's language; ar-EG gives Eastern digits).
const n0 = new Intl.NumberFormat(locale);
const n1 = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n2 = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const egp = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EGP', maximumFractionDigits: 0 });
const dayF = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
const day = (d) => dayF.format(d);
const km = (v) => (ar ? `${n0.format(v)} كم` : `${n0.format(v)} km`);

// ---- Five years of history: 2021-10-01 to 2026-09-30.
const start = Date.UTC(2021, 9, 1);
const end = Date.UTC(2026, 8, 30);
const span = end - start;
const startKm = 15440;
const endKm = 90440;
const odoAt = (t) => Math.round(startKm + ((endKm - startKm) * (t - start)) / span);

const readings = [];
// 600 fills, evenly through the five years with some jitter.
const fills = [];
let prevKm = startKm;
let lastFullKm = null;
let sinceFull = 0;
for (let i = 0; i < 600 * SCALE; i++) {
  const t = start + (span * (i + rnd() * 0.6)) / (600 * SCALE);
  const odo = odoAt(t);
  const full = rnd() > 0.2;
  const litres = Math.max(4, (odo - prevKm) * 0.068 * (0.9 + rnd() * 0.2));
  prevKm = odo;
  const price = 8.75 + (i / (600 * SCALE)) * 10.5; // EGP a litre, rising over the five years
  sinceFull += litres;
  const per100 = full && lastFullKm ? (sinceFull / Math.max(1, odo - lastFullKm)) * 100 : null;
  if (full) {
    lastFullKm = odo;
    sinceFull = 0;
  }
  fills.push({ t, odo, litres, cost: litres * price, full, per100 });
  readings.push({ t, odo, source: 'fuel', proof: null });
}
// 60 services, one about a month, each with 3–6 lines and three invoice photos.
const PARTS = ar
  ? ['زيت المحرك ٥W-30', 'فلتر زيت', 'فلتر هواء', 'فلتر تكييف', 'تيل فرامل أمامي', 'سائل فرامل', 'شمعات إشعال', 'ترصيص وضبط زوايا', 'مصنعية']
  : ['Engine oil 5W-30', 'Oil filter', 'Air filter', 'Cabin filter', 'Front brake pads', 'Brake fluid', 'Spark plugs', 'Wheel alignment', 'Labour'];
const VENDORS = ar ? ['ورشة موردوك', 'مركز الإطارات', 'مركز الخدمة'] : ["Murdock's garage", 'The tyre shop', 'The service centre'];
const services = [];
for (let i = 0; i < 60 * SCALE; i++) {
  const t = start + (span * (i + 0.5)) / (60 * SCALE);
  const odo = odoAt(t);
  const lines = Array.from({ length: 3 + Math.floor(rnd() * 4) }, () => {
    const qty = 1 + Math.floor(rnd() * 4);
    return { name: pick(PARTS), qty, amount: Math.round(150 + rnd() * 2400) };
  });
  services.push({ t, odo, vendor: pick(VENDORS), lines, photos: [0, 1, 2].map((k) => `s${String(i).padStart(3, '0')}-${k}`) });
  readings.push({ t, odo, source: 'service', proof: null });
}
// 200 readings with a proof photo (Log a reading, READING capture).
for (let i = 0; i < 200 * SCALE; i++) {
  const t = start + (span * (i + rnd() * 0.8)) / (200 * SCALE);
  readings.push({ t, odo: odoAt(t), source: 'photo', proof: `p${String(i).padStart(3, '0')}` });
}
readings.sort((a, b) => a.t - b.t);

// ---- Thumbnails: made once per size into a cache, then copied into the job directory.
const cache = path.join(here, '.tmp', `thumbs-${px}`);
mkdirSync(cache, { recursive: true });
const names = [...services.flatMap((s) => s.photos), ...readings.filter((r) => r.proof).map((r) => r.proof)];
const palette = [[201, 183, 156], [159, 180, 199], [214, 195, 139], [183, 201, 168], [199, 169, 160], [189, 189, 189]];
let made = 0;
for (let i = 0; i < names.length; i += 8) {
  await Promise.all(
    names.slice(i, i + 8).map(async (name, k) => {
      const file = path.join(cache, `${name}.jpg`);
      if (existsSync(file)) return;
      const [r, g, b] = palette[(i + k) % palette.length];
      const caption = name.startsWith('p') ? `0${40000 + (i + k) * 251}`.slice(-6) : `INV ${name}`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgb(${r},${g},${b})" stop-opacity="0.85"/><stop offset="1" stop-color="#222" stop-opacity="0.6"/></linearGradient></defs>
        <rect width="100%" height="100%" fill="url(#g)" opacity="0.35"/>
        <rect x="${px * 0.12}" y="${px * 0.38}" width="${px * 0.76}" height="${px * 0.24}" rx="${px * 0.03}" fill="#111" opacity="0.85"/>
        <text x="50%" y="${px * 0.555}" text-anchor="middle" font-family="Menlo, monospace" font-size="${px * 0.13}" fill="#9fe870">${caption}</text></svg>`;
      // A photo-like base (ImageMagick plasma, as the V34 spike used, plus sensor-like noise),
      // then the report service's own encoding.
      const { stdout: base } = await exec(
        'magick',
        ['-seed', String(1000 + i + k), '-size', `${px}x${px}`, `plasma:rgb(${r},${g},${b})-#3a3a3a`, '-attenuate', '1.2', '+noise', 'Gaussian', 'png:-'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      );
      await sharp(base)
        .composite([{ input: Buffer.from(svg), blend: 'over' }])
        .jpeg({ quality: 72, mozjpeg: true })
        .toFile(file);
      made++;
    }),
  );
}

// ---- The job directory.
mkdirSync(path.join(outDir, 'thumbs'), { recursive: true });
let thumbBytes = 0;
const proofs = readings.filter((r) => r.proof);
const shownProofs = proofCap ? proofs.slice(-proofCap) : proofs;
for (const name of [...services.flatMap((s) => s.photos), ...shownProofs.map((r) => r.proof)]) {
  copyFileSync(path.join(cache, `${name}.jpg`), path.join(outDir, 'thumbs', `${name}.jpg`));
  thumbBytes += statSync(path.join(outDir, 'thumbs', `${name}.jpg`)).size;
}

const L = ar
  ? {
      title: 'سجل المركبة', plate: 'رقم اللوحة', vin: 'رقم الشاسيه', odometer: 'العداد', year: 'سنة الصنع',
      readings: 'قراءات العداد', proofs: 'صور إثبات العداد', services: 'الصيانة', fuel: 'الوقود', documents: 'المستندات',
      date: 'التاريخ', reading: 'القراءة', source: 'المصدر', proof: 'إثبات', vendor: 'المكان', total: 'الإجمالي',
      item: 'البند', qty: 'الكمية', amount: 'المبلغ', litres: 'لتر', cost: 'التكلفة', full: 'ممتلئ', partial: 'جزئي',
      per100: 'لتر/١٠٠ كم', yearCol: 'السنة', issued: 'تاريخ الإصدار', expires: 'تاريخ الانتهاء', page: 'صفحة', of: 'من',
      fuelSrc: 'تعبئة', serviceSrc: 'صيانة', photoSrc: 'صورة', more: 'صورة أخرى في Kept', confidential: 'سري — للمالك ومن يشاركه فقط.',
    }
  : {
      title: 'Vehicle history', plate: 'Licence plate', vin: 'VIN', odometer: 'Odometer', year: 'Year',
      readings: 'Odometer readings', proofs: 'Odometer proof photos', services: 'Services', fuel: 'Fuel', documents: 'Documents',
      date: 'Date', reading: 'Reading', source: 'Source', proof: 'Proof', vendor: 'Where', total: 'Total',
      item: 'Item', qty: 'Qty', amount: 'Amount', litres: 'Litres', cost: 'Cost', full: 'Full', partial: 'Partial',
      per100: 'L/100 km', yearCol: 'Year', issued: 'Issued', expires: 'Expires', page: 'Page', of: 'of',
      fuelSrc: 'Fill', serviceSrc: 'Service', photoSrc: 'Photo', more: 'more in Kept', confidential: 'Confidential — for the owner and the people they share it with.',
    };

const years = new Map();
for (const f of fills) {
  const y = new Date(f.t).getUTCFullYear();
  const e = years.get(y) ?? { litres: 0, cost: 0, per: [] };
  e.litres += f.litres;
  e.cost += f.cost;
  if (f.per100) e.per.push(f.per100);
  years.set(y, e);
}
const yearF = new Intl.NumberFormat(locale, { useGrouping: false });
const DOCS = ar ? ['رخصة المركبة', 'وثيقة التأمين'] : ['Vehicle licence', 'Insurance policy'];

const data = {
  lang,
  dir: ar ? 'rtl' : 'ltr',
  digits: ar ? 'arab' : 'latn',
  labels: L,
  vehicle: {
    name: ar ? 'تويوتا كورولا ٢٠١٩' : 'Toyota Corolla 2019',
    // As typed into the plate field: the letters, then the digits, in reading order.
    plate: 'س ع ط ٧٤٥١',
    vin: 'JTDBR32E720123456',
    year: yearF.format(2019),
    odometer: km(endKm),
  },
  generatedLine: ar ? `أنشأه إبراهيم في ${day(new Date(end))}` : `Generated by Ibrahim on ${day(new Date(end))}`,
  footer: ar ? 'Kept · سجل المركبة · تويوتا كورولا' : 'Kept · Vehicle history · Toyota Corolla',
  counts: [
    [n0.format(services.length), L.services],
    [n0.format(fills.length), L.fuel],
    [n0.format(readings.length), L.readings],
    [n0.format(proofs.length), L.proofs],
  ],
  readings: readings.map((r) => ({
    date: day(new Date(r.t)),
    value: km(r.odo),
    source: r.source === 'fuel' ? L.fuelSrc : r.source === 'service' ? L.serviceSrc : L.photoSrc,
    proof: r.proof ? '✓' : '',
  })),
  proofs: shownProofs.map((r) => ({ photo: `/thumbs/${r.proof}.jpg`, date: day(new Date(r.t)), value: km(r.odo) })),
  proofsMore: proofCap && proofs.length > proofCap ? `+${n0.format(proofs.length - proofCap)} ${L.more}` : '',
  services: services.map((s) => ({
    date: day(new Date(s.t)),
    odometer: km(s.odo),
    vendor: s.vendor,
    total: egp.format(s.lines.reduce((a, l) => a + l.amount, 0)),
    lines: s.lines.map((l) => ({ name: l.name, qty: n0.format(l.qty), amount: egp.format(l.amount) })),
    photos: s.photos.map((p) => `/thumbs/${p}.jpg`),
  })),
  fuelYears: [...years.entries()].map(([y, e]) => ({
    year: yearF.format(y),
    litres: n1.format(e.litres),
    cost: egp.format(e.cost),
    per100: e.per.length ? n1.format(e.per.reduce((a, b) => a + b, 0) / e.per.length) : '—',
  })),
  fills: fills.map((f) => ({
    date: day(new Date(f.t)),
    odometer: km(f.odo),
    litres: n2.format(f.litres),
    cost: egp.format(f.cost),
    kind: f.full ? L.full : L.partial,
    per100: f.per100 ? n1.format(f.per100) : '—',
  })),
  documents: Array.from({ length: 10 }, (_, i) => {
    const y = 2021 + Math.floor(i / 2);
    const issued = Date.UTC(y, i % 2 ? 2 : 9, 12);
    return {
      name: DOCS[i % 2],
      issued: day(new Date(issued)),
      expires: day(new Date(issued + 365 * 86400000)),
      cost: egp.format(i % 2 ? 9800 + i * 400 : 1450 + i * 60),
    };
  }),
};
writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(data));
console.log(
  JSON.stringify({
    lang,
    px,
    thumbsMade: made,
    thumbs: names.length - (proofs.length - shownProofs.length),
    thumbKB: Math.round(thumbBytes / 1024),
    readings: readings.length,
    fills: fills.length,
    services: services.length,
    proofs: shownProofs.length,
  }),
);
