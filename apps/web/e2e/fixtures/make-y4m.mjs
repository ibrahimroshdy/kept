#!/usr/bin/env node
// The fake camera's videos for the step-3 e2e run (plan T32): Chromium plays a .y4m file as the
// camera with `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>`
// (playwright.config.ts, e2e/camera.ts). Written from code, so they are reproducible and nothing
// is downloaded:
//
//   node apps/web/e2e/fixtures/make-y4m.mjs
//
// - camera-qr.y4m: a Kept label's QR for the seeded Bosch drill (households seed, code 2HX9RB;
//   apps/server/src/seed/inventory.ts). The host is ignored when a label is read (D120), so any
//   host will do.
// - camera-thing.y4m: a plain scene for Capture's shutter: a grey ramp with a dark block, so the
//   photo isn't blank. The mock AI names it from its defaults ("Thing", apps/server/src/ai/mock.ts).
//
// Each is one 4:2:0 frame (Chromium loops it), 320×320: about 150 KB each.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { encode } = require('uqr');

export const QR_CODE = '2HX9RB';
export const QR_TEXT = `https://kept.example/l/${QR_CODE}`;

const W = 320;
const H = 320;

/** One frame of a 4:2:0 Y4M file: the luma plane from `luma(x, y)`, grey chroma. */
function y4m(luma) {
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F5:1 Ip A1:1 C420jpeg\nFRAME\n`, 'ascii');
  const y = Buffer.alloc(W * H);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) y[row * W + col] = luma(col, row);
  }
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  return Buffer.concat([header, y, chroma]);
}

function qrFrame(text) {
  // A 4-module quiet zone, black modules on white, as big as fits.
  const { size, data } = encode(text, { ecc: 'M', border: 4 });
  const scale = Math.floor(Math.min(W, H) / size);
  const offX = Math.floor((W - size * scale) / 2);
  const offY = Math.floor((H - size * scale) / 2);
  return y4m((x, y) => {
    const mx = Math.floor((x - offX) / scale);
    const my = Math.floor((y - offY) / scale);
    if (mx < 0 || my < 0 || mx >= size || my >= size) return 235;
    return data[my]?.[mx] ? 16 : 235;
  });
}

function sceneFrame() {
  return y4m((x, y) => {
    if (x > 100 && x < 220 && y > 120 && y < 240) return 40;
    return 90 + Math.floor((x + y) / 6);
  });
}

const here = (name) => new URL(name, import.meta.url);
writeFileSync(here('camera-qr.y4m'), qrFrame(QR_TEXT));
writeFileSync(here('camera-thing.y4m'), sceneFrame());
console.log(`make-y4m: camera-qr.y4m (${QR_TEXT}) and camera-thing.y4m, ${W}×${H}, one frame`);
