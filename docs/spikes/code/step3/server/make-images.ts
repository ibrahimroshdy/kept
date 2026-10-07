// SPIKE (step 3, L50 real-provider run): renders the four synthetic test photos with sharp.
// Run from a folder where `sharp` resolves: node make-images.ts <outDir>
// Output JPEGs carry no EXIF/GPS (sharp drops metadata unless .withMetadata() is called).
import sharp from 'sharp';

const out = process.argv[2] ?? '.';

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

const receiptAr = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900">
<rect width="100%" height="100%" fill="#f7f5ef"/>
<g font-family="Geeza Pro, Arial, sans-serif" fill="#1d1d1d" direction="rtl">
<text x="320" y="80" font-size="36" font-weight="bold" text-anchor="middle">سوبر ماركت النيل</text>
<text x="320" y="120" font-size="22" text-anchor="middle">٤٥ شارع شبرا، القاهرة</text>
<text x="600" y="190" font-size="24" text-anchor="start">التاريخ: 2026/09/14</text>
<line x1="40" y1="220" x2="600" y2="220" stroke="#222" stroke-dasharray="6 4"/>
<text x="600" y="270" font-size="24" text-anchor="start">أرز مصري ١ كجم</text>
<text x="40" y="270" font-size="24" direction="ltr" text-anchor="start">2 x 32.50 = 65.00</text>
<text x="600" y="330" font-size="24" text-anchor="start">زيت عباد الشمس</text>
<text x="40" y="330" font-size="24" direction="ltr" text-anchor="start">1 x 95.00 = 95.00</text>
<line x1="40" y1="370" x2="600" y2="370" stroke="#222" stroke-dasharray="6 4"/>
<text x="600" y="430" font-size="32" font-weight="bold" text-anchor="start">الإجمالي</text>
<text x="40" y="430" font-size="32" font-weight="bold" direction="ltr" text-anchor="start">160.00 ج.م</text>
<text x="320" y="540" font-size="22" text-anchor="middle">شكراً لزيارتكم</text>
</g></svg>`;

// Seven-segment digits: segments a..g as polygons in a 40x70 cell.
const SEG: Record<string, string> = {
  a: '6,2 34,2 30,8 10,8', b: '36,4 36,33 31,30 31,9', c: '36,37 36,66 31,61 31,40',
  d: '6,68 34,68 30,62 10,62', e: '4,37 9,40 9,61 4,66', f: '4,4 9,9 9,30 4,33',
  g: '6,35 10,31 30,31 34,35 30,39 10,39',
};
const DIGIT: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd',
  '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcfgd',
};
const digits = '052340'
  .split('')
  .map((d, i) =>
    Object.keys(SEG)
      .map((s) => `<polygon transform="translate(${60 + i * 58},60) scale(1.3)" points="${SEG[s]}" fill="${DIGIT[d]!.includes(s) ? '#b8f36a' : '#23301c'}"/>`)
      .join(''),
  )
  .join('');
const odometer = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="240">
<rect width="100%" height="100%" fill="#141414"/>
<rect x="40" y="40" width="480" height="140" rx="10" fill="#0c120a" stroke="#333" stroke-width="3"/>
${digits}
<text x="470" y="160" font-family="Helvetica, Arial" font-size="26" fill="#b8f36a">km</text>
<text x="60" y="215" font-family="Helvetica, Arial" font-size="18" fill="#777">ODO</text>
</svg>`;

const label = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480">
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

const cases: Array<[string, string]> = [
  ['receipt-en', receiptEn],
  ['receipt-ar', receiptAr],
  ['odometer', odometer],
  ['label', label],
];
for (const [name, svg] of cases) {
  const info = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(`${out}/${name}.jpg`);
  console.log(name, `${info.width}x${info.height}`, info.size, 'bytes');
}
// The T9 "Test connection" fixture: a 64x64 solid square.
const sq = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#d23c3c' } })
  .jpeg({ quality: 85 })
  .toFile(`${out}/square-64.jpg`);
console.log('square-64', '64x64', sq.size, 'bytes');
