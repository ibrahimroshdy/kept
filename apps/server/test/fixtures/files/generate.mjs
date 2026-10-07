// Regenerates the tiny upload fixtures in this directory (step 2, T2; D117, D157). The files are
// committed; run this only to change them:
//
//   node apps/server/test/fixtures/files/generate.mjs
//
// sharp is the root devDependency. HEIC can't be encoded by sharp's prebuilt libvips (HEVC), so
// image.heic is a bare `ftyp` box: enough for content sniffing, which is all it is used for.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = (name, data) => writeFile(path.join(dir, name), data);

const pixels = (background) => ({ create: { width: 8, height: 4, channels: 3, background } });

// A photo with a GPS block (Cairo), as a phone would take it: derivatives must strip it.
await out(
  'photo.jpg',
  await sharp(pixels('#c33'))
    .jpeg({ quality: 50 })
    .withExif({
      IFD0: { Make: 'Kept', Model: 'Fixture' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '30/1 2/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '31/1 14/1 0/1',
      },
    })
    .toBuffer(),
);

// Stored landscape (8×4) with EXIF orientation 6: shown portrait once rotation is baked in.
await out(
  'rotated.jpg',
  await sharp(pixels('#3c3')).jpeg({ quality: 50 }).withMetadata({ orientation: 6 }).toBuffer(),
);

// A one-page PDF, written by hand (offsets computed so the xref table is valid).
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>',
];
let pdf = '%PDF-1.4\n';
const offsets = objects.map((body, i) => {
  const at = pdf.length;
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  return at;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const at of offsets) pdf += `${String(at).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await out('doc.pdf', pdf);

// HTML renamed to .jpg: the declared type and the name must not matter (D157).
await out('fake.jpg', '<!doctype html><html><body><script>alert(1)</script></body></html>\n');

// SVG is refused as an attachment in step 2 (Q9).
await out(
  'drawing.svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"><title>Box</title><rect width="8" height="4"/></svg>\n',
);

/** An ISO-BMFF `ftyp` box: size, 'ftyp', major brand, minor version 0, compatible brands. */
function ftyp(major, ...compatible) {
  const brands = [major, ...compatible];
  const box = Buffer.alloc(16 + 4 * compatible.length);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(brands[0], 8, 'latin1');
  box.writeUInt32BE(0, 12);
  compatible.forEach((brand, i) => {
    box.write(brand, 16 + 4 * i, 'latin1');
  });
  return box;
}

await out('image.heic', ftyp('heic', 'mif1', 'heic'));
// A video (D170: only allowed through the video flag).
await out('clip.mp4', ftyp('isom', 'isom', 'mp41'));
