// Renders the synthetic evaluation photos in this directory (step 3, T11; V1, V2, V3). The JPEGs
// are committed, and cases.json beside them holds each one's mode and expected values. Run this
// only to change them (the fonts are the Mac's, so another machine renders different bytes):
//
//   node apps/server/test/fixtures/eval/generate.mjs
//
// Every photo is drawn here from SVG: nothing is downloaded, and nothing is a real document. The
// receipt-en, label-nameplate and reading-odometer drawings are the step-3 spike's
// (docs/spikes/code/step3/server/make-images.ts), so the harness's numbers compare with the
// spike's. sharp writes no EXIF unless asked, so the files carry no metadata.
//
// These are a smoke set. V1 and V3 are proven only by the maintainer's real photos (README.md).

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = path.dirname(fileURLToPath(import.meta.url));

// --- Receipts ----------------------------------------------------------------------------------

const receiptEn = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900">
<rect width="100%" height="100%" fill="#f4f1ea"/>
<g font-family="Menlo, Courier New, monospace" fill="#222">
<text x="320" y="80" font-size="34" font-weight="bold" text-anchor="middle">CAIRO HOME STORE</text>
<text x="320" y="118" font-size="20" text-anchor="middle">12 Tahrir St, Dokki, Giza</text>
<text x="320" y="146" font-size="20" text-anchor="middle">Tel 02 3761 4420</text>
<text x="40" y="210" font-size="22">Date: 14/09/2026   14:32</text>
<text x="40" y="240" font-size="22">Receipt #004817</text>
<line x1="40" y1="265" x2="600" y2="265" stroke="#222" stroke-dasharray="6 4"/>
<text x="40" y="310" font-size="22">LED Bulb 9W</text>
<text x="40" y="340" font-size="22">  2 x 45.00</text><text x="600" y="340" font-size="22" text-anchor="end">90.00</text>
<text x="40" y="390" font-size="22">Extension Cord 3m</text>
<text x="40" y="420" font-size="22">  1 x 210.00</text><text x="600" y="420" font-size="22" text-anchor="end">210.00</text>
<line x1="40" y1="450" x2="600" y2="450" stroke="#222" stroke-dasharray="6 4"/>
<text x="40" y="500" font-size="30" font-weight="bold">TOTAL EGP</text><text x="600" y="500" font-size="30" font-weight="bold" text-anchor="end">300.00</text>
<text x="40" y="545" font-size="20">Paid: VISA ****</text>
<text x="320" y="640" font-size="20" text-anchor="middle">Thank you for shopping with us</text>
</g></svg>`;

// Arabic, with Arabic-Indic digits throughout (the date, the amounts and the total) and the
// Arabic decimal separator.
const receiptAr = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900">
<rect width="100%" height="100%" fill="#f7f5ef"/>
<g font-family="Geeza Pro, Arial, sans-serif" fill="#1d1d1d">
<text x="320" y="80" font-size="36" font-weight="bold" text-anchor="middle">سوبر ماركت النيل</text>
<text x="320" y="122" font-size="22" text-anchor="middle">٤٥ شارع شبرا، القاهرة</text>
<text x="600" y="190" font-size="24" text-anchor="end">التاريخ: ١٤/٠٩/٢٠٢٦</text>
<line x1="40" y1="220" x2="600" y2="220" stroke="#222" stroke-dasharray="6 4"/>
<text x="600" y="270" font-size="24" text-anchor="end">أرز مصري ١ كجم</text>
<text x="600" y="305" font-size="22" text-anchor="end">٢ × ٣٢٫٥٠</text>
<text x="40" y="305" font-size="24">٦٥٫٠٠</text>
<text x="600" y="355" font-size="24" text-anchor="end">زيت عباد الشمس</text>
<text x="600" y="390" font-size="22" text-anchor="end">١ × ٩٥٫٠٠</text>
<text x="40" y="390" font-size="24">٩٥٫٠٠</text>
<line x1="40" y1="420" x2="600" y2="420" stroke="#222" stroke-dasharray="6 4"/>
<text x="600" y="475" font-size="32" font-weight="bold" text-anchor="end">الإجمالي</text>
<text x="40" y="475" font-size="32" font-weight="bold">١٦٠٫٠٠ ج.م</text>
<text x="320" y="560" font-size="22" text-anchor="middle">شكراً لزيارتكم</text>
</g></svg>`;

// A receipt lying on a table, so the paper's outline is known: x 0.30–0.70, y 0.10–0.90 of a
// 1200×900 photo. A bare "$" (ambiguous, D189) and printed warranty terms (D55).
const receiptTable = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
<rect width="100%" height="100%" fill="#8a5a32"/>
${Array.from({ length: 18 }, (_, i) => `<rect x="0" y="${i * 50 + 12}" width="1200" height="3" fill="#7a4d2a" opacity="0.7"/>`).join('')}
<rect x="366" y="98" width="480" height="720" fill="#000" opacity="0.25"/>
<rect x="360" y="90" width="480" height="720" fill="#fbfaf6"/>
<g font-family="Menlo, Courier New, monospace" fill="#222">
<text x="600" y="150" font-size="28" font-weight="bold" text-anchor="middle">SUNRISE HARDWARE</text>
<text x="600" y="182" font-size="16" text-anchor="middle">480 Maple Ave, Springfield</text>
<text x="390" y="235" font-size="18">Sep 20, 2026  10:05</text>
<line x1="390" y1="255" x2="810" y2="255" stroke="#222" stroke-dasharray="5 4"/>
<text x="390" y="295" font-size="18">Hammer 16oz</text>
<text x="390" y="320" font-size="18">  1 x 18.00</text><text x="810" y="320" font-size="18" text-anchor="end">18.00</text>
<text x="390" y="360" font-size="18">Tape Measure 25ft</text>
<text x="390" y="385" font-size="18">  1 x 12.50</text><text x="810" y="385" font-size="18" text-anchor="end">12.50</text>
<text x="390" y="425" font-size="18">Wood Screws (100)</text>
<text x="390" y="450" font-size="18">  2 x 6.00</text><text x="810" y="450" font-size="18" text-anchor="end">12.00</text>
<line x1="390" y1="475" x2="810" y2="475" stroke="#222" stroke-dasharray="5 4"/>
<text x="390" y="520" font-size="24" font-weight="bold">TOTAL</text><text x="810" y="520" font-size="24" font-weight="bold" text-anchor="end">$42.50</text>
<text x="600" y="600" font-size="16" text-anchor="middle">Tools carry a 1-year limited warranty.</text>
<text x="600" y="625" font-size="16" text-anchor="middle">Keep this receipt.</text>
</g></svg>`;

// --- Labels -------------------------------------------------------------------------------------

const nameplate = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480">
<rect width="100%" height="100%" fill="#2a2a2a"/>
<rect x="30" y="30" width="660" height="420" fill="#fafafa" stroke="#999"/>
<g font-family="Helvetica, Arial, sans-serif" fill="#111">
<text x="60" y="95" font-size="44" font-weight="bold" letter-spacing="4">SAMSUNG</text>
<text x="60" y="150" font-size="28">55" Neo QLED 4K  QN90</text>
<text x="60" y="210" font-size="24">Model Code: QN55QN90DAFXZA</text>
<text x="60" y="255" font-size="24">Serial No.: 0B7H3CAW500123K</text>
<text x="60" y="300" font-size="20">AC 110-120V 60Hz  195W</text>
<text x="60" y="340" font-size="20">Manufactured: 2024.03</text>
<text x="60" y="400" font-size="16" fill="#555">Made in Mexico</text>
</g>
<g fill="#111">${Array.from({ length: 40 }, (_, i) => `<rect x="${420 + i * 6}" y="360" width="${i % 3 ? 2 : 4}" height="60"/>`).join('')}</g>
</svg>`;

// An Egyptian-style vehicle licence card, in Arabic with Arabic-Indic digits. Marked as a test
// sample on its face; the owner is the sample cast's Alfred, and the VIN is invented (a
// non-North-American WMI, so it has no check digit).
const registration = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="640">
<rect width="100%" height="100%" fill="#3b3b3b"/>
<rect x="40" y="40" width="920" height="560" rx="24" fill="#e6f0e8" stroke="#6b8f72" stroke-width="4"/>
<g font-family="Geeza Pro, Arial, sans-serif" fill="#1b2a1e">
<text x="500" y="100" font-size="36" font-weight="bold" text-anchor="middle">رخصة تسيير مركبة ملاكي</text>
<text x="500" y="135" font-size="18" text-anchor="middle" fill="#9a3b3b">نموذج اختبار — ليست وثيقة رسمية</text>
<rect x="620" y="160" width="300" height="70" rx="8" fill="#fff" stroke="#1b2a1e" stroke-width="2"/>
<text x="770" y="210" font-size="36" font-weight="bold" text-anchor="middle">ق ط ر ١٢٣٤</text>
<text x="600" y="205" font-size="22" text-anchor="end">:رقم اللوحة</text>
<text x="920" y="280" font-size="24" text-anchor="end">اسم المالك: ألفريد</text>
<text x="920" y="325" font-size="24" text-anchor="end">الماركة: هيونداي</text>
<text x="520" y="325" font-size="24" text-anchor="end">الطراز: إلنترا</text>
<text x="920" y="370" font-size="24" text-anchor="end">سنة الصنع: ٢٠٢١</text>
<text x="920" y="415" font-size="24" text-anchor="end">:رقم الشاسيه</text>
<text x="80" y="415" font-size="26" font-family="Menlo, Courier New, monospace">KMHD741CBMU123456</text>
<text x="920" y="460" font-size="24" text-anchor="end">تاريخ الترخيص: ١٥/٠٣/٢٠٢٥</text>
<text x="920" y="505" font-size="24" text-anchor="end">تاريخ الانتهاء: ١٥/٠٣/٢٠٢٨</text>
<text x="920" y="560" font-size="20" text-anchor="end">وحدة المرور: القاهرة</text>
</g></svg>`;

// --- A seven-segment odometer (V1) --------------------------------------------------------------

const SEG = {
  a: '6,2 34,2 30,8 10,8',
  b: '36,4 36,33 31,30 31,9',
  c: '36,37 36,66 31,61 31,40',
  d: '6,68 34,68 30,62 10,62',
  e: '4,37 9,40 9,61 4,66',
  f: '4,4 9,9 9,30 4,33',
  g: '6,35 10,31 30,31 34,35 30,39 10,39',
};
const DIGIT = {
  0: 'abcdef',
  1: 'bc',
  2: 'abged',
  3: 'abgcd',
  4: 'fgbc',
  5: 'afgcd',
  6: 'afgedc',
  7: 'abc',
  8: 'abcdefg',
  9: 'abcfgd',
};
const segments = '052340'
  .split('')
  .map((d, i) =>
    Object.keys(SEG)
      .map(
        (s) =>
          `<polygon transform="translate(${60 + i * 58},60) scale(1.3)" points="${SEG[s]}" fill="${DIGIT[d].includes(s) ? '#b8f36a' : '#23301c'}"/>`,
      )
      .join(''),
  )
  .join('');
const odometer = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="240">
<rect width="100%" height="100%" fill="#141414"/>
<rect x="40" y="40" width="480" height="140" rx="10" fill="#0c120a" stroke="#333" stroke-width="3"/>
${segments}
<text x="470" y="160" font-family="Helvetica, Arial" font-size="26" fill="#b8f36a">km</text>
<text x="60" y="215" font-family="Helvetica, Arial" font-size="18" fill="#777">ODO</text>
</svg>`;

// --- Things -------------------------------------------------------------------------------------

// A boxed drill of an invented brand, with its model printed on the box.
const drillBox = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900">
<rect width="100%" height="100%" fill="#cfcac2"/>
<rect x="0" y="700" width="900" height="200" fill="#a79f94"/>
<polygon points="190,160 710,160 760,120 240,120" fill="#c2561b"/>
<polygon points="710,160 760,120 760,700 710,740" fill="#8f3d12"/>
<rect x="190" y="160" width="520" height="580" fill="#e8671f"/>
<g font-family="Helvetica, Arial, sans-serif" fill="#111">
<text x="450" y="240" font-size="72" font-weight="bold" text-anchor="middle" letter-spacing="6">VOLTA</text>
<text x="450" y="300" font-size="34" text-anchor="middle">Cordless Drill 18V</text>
<text x="450" y="700" font-size="26" text-anchor="middle">Model VD-18X</text>
</g>
<g transform="translate(250,340)">
<rect x="40" y="40" width="250" height="90" rx="20" fill="#222"/>
<rect x="290" y="70" width="90" height="30" fill="#888"/>
<rect x="380" y="78" width="60" height="14" fill="#bbb"/>
<polygon points="110,130 190,130 170,280 90,280" fill="#222"/>
<rect x="70" y="280" width="140" height="50" rx="8" fill="#444"/>
</g>
</svg>`;

// A plain red mug on a table.
const mug = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
<rect width="100%" height="100%" fill="#eef1f4"/>
<rect x="0" y="560" width="800" height="240" fill="#c9b79c"/>
<ellipse cx="380" cy="600" rx="170" ry="22" fill="#000" opacity="0.18"/>
<path d="M530 330 C 640 330 640 520 530 520" fill="none" stroke="#c0262d" stroke-width="34"/>
<path d="M230 260 L530 260 L515 580 Q380 610 245 580 Z" fill="#d42a31"/>
<ellipse cx="380" cy="260" rx="150" ry="26" fill="#9e1c22"/>
<ellipse cx="380" cy="260" rx="132" ry="18" fill="#3a1a12"/>
</svg>`;

// A shelf with three objects, for multi-item boxes (V2, 1.x): measured only.
// Boxes (x, y, w, h in px of 1200×800): mug 150,400,190,160 · book 450,250,90,310 · plant 680,250,200,310.
const shelf = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
<rect width="100%" height="100%" fill="#dfe6ea"/>
<rect x="60" y="560" width="1080" height="30" fill="#7a5230"/>
<rect x="60" y="590" width="1080" height="10" fill="#5b3b20"/>
<path d="M300 440 C 345 440 345 520 300 520" fill="none" stroke="#b3252b" stroke-width="16"/>
<rect x="150" y="400" width="150" height="160" rx="10" fill="#d42a31"/>
<rect x="450" y="250" width="90" height="310" fill="#1f4e99"/>
<rect x="450" y="250" width="14" height="310" fill="#163a73"/>
<text x="495" y="410" font-family="Helvetica, Arial" font-size="22" fill="#f2d16b" text-anchor="middle" transform="rotate(-90 495 410)">ATLAS</text>
<polygon points="700,440 860,440 840,560 720,560" fill="#c46a3a"/>
<ellipse cx="740" cy="360" rx="60" ry="95" fill="#3f8f3a" transform="rotate(-25 740 360)"/>
<ellipse cx="820" cy="350" rx="60" ry="100" fill="#4ea846" transform="rotate(25 820 350)"/>
<ellipse cx="780" cy="330" rx="45" ry="80" fill="#367a31"/>
</svg>`;

const cases = [
  ['receipt-en', receiptEn],
  ['receipt-ar', receiptAr],
  ['receipt-table', receiptTable],
  ['label-nameplate', nameplate],
  ['label-registration-ar', registration],
  ['reading-odometer', odometer],
  ['thing-drill-box', drillBox],
  ['thing-mug', mug],
  ['multi-shelf', shelf],
];

for (const [name, svg] of cases) {
  const file = path.join(dir, `${name}.jpg`);
  const data = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  await writeFile(file, data);
  const m = await sharp(data).metadata();
  console.log(name, `${m.width}x${m.height}`, data.length, 'bytes');
}
