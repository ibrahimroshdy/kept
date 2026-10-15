#!/usr/bin/env node
// The map shape picker's pictures (D249): every shape in MAP_MODELS rendered once, the way the map
// draws it (map-thumbs/render.ts, in headless Chromium through a Vite dev server, no devices), then
// packed by sharp into one WebP sprite with a transparent background, and an index of its cells:
//
//   src/map/thumbs/shapes.webp   one cell per shape, CELL px square, COLS per row
//   src/map/thumbs/sprite.ts     the cell size, the columns and each shape's cell
//
// Dev only: run it after adding or changing a shape, and commit both outputs
// (`node apps/web/scripts/render-map-thumbs.mjs`). The picker loads the sprite only when it opens.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(`${web}package.json`);
const rootRequire = createRequire(fileURLToPath(new URL('../../../package.json', import.meta.url)));
const { createServer } = await import(require.resolve('vite'));
const { chromium } = require('@playwright/test');
const sharp = rootRequire('sharp');

/** Pixels per cell: shown at half that on a 2x screen. */
const CELL = Number(process.env.CELL ?? 88);
const COLS = 8;
const QUALITY = Number(process.env.QUALITY ?? 64);

const server = await createServer({
  configFile: false,
  root: web,
  logLevel: 'error',
  server: { port: 0, host: '127.0.0.1' },
  define: { 'process.env.KEPT_VERSION': 'undefined' },
  optimizeDeps: { entries: ['scripts/map-thumbs/index.html'] },
});
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let thumbs;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto(`http://127.0.0.1:${port}/scripts/map-thumbs/index.html?size=${CELL * 3}`);
  await page.waitForFunction(() => window.thumbs || window.thumbsError, null, { timeout: 120_000 });
  const err = await page.evaluate(() => window.thumbsError);
  if (err) throw new Error(err);
  thumbs = await page.evaluate(() => window.thumbs);
} finally {
  await browser.close();
  await server.close();
}

const keys = Object.keys(thumbs);
const rows = Math.ceil(keys.length / COLS);
const cells = await Promise.all(
  keys.map((k) =>
    sharp(Buffer.from(thumbs[k].split(',')[1], 'base64'))
      .resize(CELL, CELL, { kernel: 'lanczos3' })
      .png()
      .toBuffer(),
  ),
);
const sprite = await sharp({
  create: {
    width: COLS * CELL,
    height: rows * CELL,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(
    cells.map((input, i) => ({ input, left: (i % COLS) * CELL, top: Math.floor(i / COLS) * CELL })),
  )
  .webp({
    quality: QUALITY,
    alphaQuality: Number(process.env.ALPHA ?? 70),
    effort: 6,
    smartSubsample: true,
  })
  .toBuffer();

const out = `${web}src/map/thumbs/`;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}shapes.webp`, sprite);
writeFileSync(
  `${out}sprite.ts`,
  `/**
 * The shape picker's sprite (D249), written by scripts/render-map-thumbs.mjs: don't edit by hand.
 * Each shape's picture is one CELL px square cell of shapes.webp, COLS cells per row.
 */
import type { MapModelKey } from '@kept/shared';

export const THUMB_CELL = ${CELL};
export const THUMB_COLS = ${COLS};
export const THUMB_ROWS = ${rows};

/** Each shape's cell, row by row. */
export const THUMB_CELLS: Readonly<Record<MapModelKey, number>> = {
${keys.map((k, i) => `  ${k}: ${i},`).join('\n')}
};
`,
);
console.log(
  `${keys.length} shapes, ${COLS}×${rows} cells of ${CELL} px: shapes.webp ${sprite.length} bytes`,
);
