#!/usr/bin/env node
// The service invoice the step-5 e2e attaches in Log a service (e2e/step5.spec.ts): Bay Motors'
// oil change on the Corolla, three lines in EGP. Written from code, so it is reproducible and
// nothing is downloaded:
//
//   node apps/web/e2e/fixtures/make-invoice.mjs
//
// The mock provider doesn't read it: it answers by the hash of the image it is sent
// (apps/server/src/ai/mock.ts), and e2e/serve.mjs keys this file's answer in mock-answers.json to
// its bytes, re-encoded as the server re-encodes a receipt before sending it.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// sharp is the server's dependency, not the web app's.
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const sharp = require('sharp');

const W = 520;
const H = 680;
const lines = [
  ['BAY MOTORS', 'middle', 34, 'bold'],
  ['Service invoice  2026-10-04', 'middle', 22, 'normal'],
  ['', 'middle', 16, 'normal'],
  ['Engine oil 5W-30  4 x 350   1400', 'start', 22, 'normal'],
  ['Oil filter                   250', 'start', 22, 'normal'],
  ['Labour                       600', 'start', 22, 'normal'],
  ['', 'middle', 16, 'normal'],
  ['TOTAL EGP                   2250', 'start', 24, 'bold'],
];
let y = 70;
const text = lines
  .map(([s, anchor, size, weight]) => {
    y += Number(size) + 22;
    const x = anchor === 'middle' ? W / 2 : 30;
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Courier, monospace" font-size="${size}" font-weight="${weight}">${s}</text>`;
  })
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#eef1f4"/>${text}</svg>`;

const out = new URL('invoice-service.jpg', import.meta.url);
writeFileSync(out, await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer());
console.log(`make-invoice: invoice-service.jpg, ${W}×${H}`);
