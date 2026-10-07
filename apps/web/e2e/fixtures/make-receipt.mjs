#!/usr/bin/env node
// The receipt photo the step-3 e2e picks from the Gallery in Receipt mode (e2e/step3.spec.ts):
// a till receipt priced with a bare `$`, which Kept can't place between US and Canadian dollars
// (D189). Written from code, so it is reproducible and nothing is downloaded:
//
//   node apps/web/e2e/fixtures/make-receipt.mjs
//
// The mock provider doesn't read it: it answers by the hash of the image it is sent
// (apps/server/src/ai/mock.ts), and e2e/serve.mjs keys the answer in mock-answers.json to this
// file's bytes, re-encoded as the server re-encodes a receipt before sending it.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// sharp is the server's dependency, not the web app's.
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const sharp = require('sharp');

const W = 480;
const H = 640;
const lines = [
  ['CORNER HARDWARE', 'middle', 34, 'bold'],
  ['14 Sep 2026  10:42', 'middle', 22, 'normal'],
  ['', 'middle', 16, 'normal'],
  ['Tape measure 5 m      $12.50', 'start', 24, 'normal'],
  ['Utility knife          $8.00', 'start', 24, 'normal'],
  ['', 'middle', 16, 'normal'],
  ['TOTAL                 $20.50', 'start', 26, 'bold'],
  ['THANK YOU', 'middle', 22, 'normal'],
];
let y = 70;
const text = lines
  .map(([s, anchor, size, weight]) => {
    y += Number(size) + 22;
    const x = anchor === 'middle' ? W / 2 : 40;
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Courier, monospace" font-size="${size}" font-weight="${weight}">${s}</text>`;
  })
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f4f1e8"/>${text}</svg>`;

const out = new URL('receipt-usd.jpg', import.meta.url);
writeFileSync(out, await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer());
console.log(`make-receipt: receipt-usd.jpg, ${W}×${H}`);
