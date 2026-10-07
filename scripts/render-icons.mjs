#!/usr/bin/env node
// Every Kept logo file (D135, "B · Label tape"), from one geometry. The mark is a square of amber
// label tape with a heavy mono "K" (Plex Mono SemiBold's outline, so no font is needed) and the
// tape's punched hole at the top start, at every size. The lockup is that mark with KEPT beside it
// in the same outlines. Writes the SVG sources and rasterises them with sharp:
//
//   apps/web/public/favicon.svg            tab icon, any size; the hole is cut out
//   apps/web/public/favicon-32.png         the PNG fallback, the same
//   apps/web/public/apple-touch-icon.png   180, full bleed (iOS rounds the corners itself)
//   apps/web/public/icon-192.png           192, rounded tape with the hole
//   apps/web/public/icon-512.png           512, the same
//   apps/web/public/icon-maskable-512.png  512, full bleed, everything inside the central 80%
//   apps/docs/public/favicon.svg           the docs site's tab icon (= the app's)
//   apps/docs/src/assets/logo.svg          the docs site's logo (= the app's favicon)
//   docs/assets/kept-lockup-light.svg      the README lockup, on GitHub's light page
//   docs/assets/kept-lockup-dark.svg       the same, on GitHub's dark page
//
// The geometry matches AppMark and BrandLockup in apps/web/src/components/brand.tsx. Dev only: run
// it after changing either, and commit the outputs (`node scripts/render-icons.mjs`).
// scripts/render-social-preview.mjs draws the GitHub social preview from lockupSvg().
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const TAPE = '#F0B03A';
const INK = '#2E2100';
/** The paper behind the tape, seen through the hole in the opaque app icons. */
const HOLE = '#FBFAF7';

const root = fileURLToPath(new URL('../', import.meta.url));

/** The Plex Mono SemiBold outlines (1000 units per em, advance 600, baseline y=0), as in brand.tsx. */
export const GLYPHS = {
  K: 'M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z',
  E: 'M83 0V698H524V590H214V408H513V300H214V108H524V0Z',
  P: 'M80 0V698H345Q447 698 501 640Q555 582 555 482Q555 382 501 324Q447 266 345 266H211V0ZM211 373H318Q371 373 394 394.5Q417 416 417 463V501Q417 548 394 569.5Q371 591 318 591H211Z',
  T: 'M365 590V0H235V590H25V698H575V590Z',
};

/** The tape, rounded, with the hole cut out (even-odd), so it shows whatever the mark sits on. */
export const TAPE_CUT =
  'M9 2H55A7 7 0 0 1 62 9V55A7 7 0 0 1 55 62H9A7 7 0 0 1 2 55V9A7 7 0 0 1 9 2ZM12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5Z';
const K_MARK = 'translate(21.4 48) scale(0.042 -0.042)';

/** The lockup's width in mark units (the mark is 64): KEPT at the mark's K size and baseline. */
export const LOCKUP_W = 191;
/** KEPT: the mark's K scale (0.042) and baseline (48), 0.12 em tracking, from x=74. */
const WORDMARK = ['K', 'E', 'P', 'T']
  .map(
    (g, i) =>
      `<path d="${GLYPHS[g]}" transform="translate(${+(74 + i * 30.2).toFixed(1)} 48) scale(0.042 -0.042)"/>`,
  )
  .join('');

/** The mark's art in its 64-unit square. `hole` fills the hole instead of cutting it. */
function markArt(hole) {
  return hole
    ? `<rect x="2" y="2" width="60" height="60" rx="7" fill="${TAPE}"/><circle cx="12" cy="12" r="3.5" fill="${hole}"/><path d="${GLYPHS.K}" fill="${INK}" transform="${K_MARK}"/>`
    : `<path d="${TAPE_CUT}" fill="${TAPE}" fill-rule="evenodd"/><path d="${GLYPHS.K}" fill="${INK}" transform="${K_MARK}"/>`;
}

/**
 * The square mark. By default the hole is cut out (favicons, logos). `hole` paints it instead, for
 * the opaque app icons; `bleed` squares the tape off to the edges for icons the platform masks
 * itself; `inset` shrinks the artwork towards the centre (the maskable safe zone).
 */
export function markSvg({ hole, bleed = false, inset = 0, size = 64 } = {}) {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><title>Kept</title>`;
  if (!bleed) return `${head}${markArt(hole)}</svg>`;
  // Full bleed: the whole square is tape; the hole and K keep the mark's places, scaled by inset.
  const scale = 1 - inset * 2;
  const art = `<circle cx="12" cy="12" r="3.5" fill="${hole ?? HOLE}"/><path d="${GLYPHS.K}" fill="${INK}" transform="${K_MARK}"/>`;
  const body = inset
    ? `<g transform="translate(${32 * (1 - scale)} ${32 * (1 - scale)}) scale(${scale})">${art}</g>`
    : art;
  return `${head}<rect width="64" height="64" fill="${TAPE}"/>${body}</svg>`;
}

/** The lockup: the mark (hole cut out) and KEPT in `ink`, `height` px tall. */
export function lockupSvg({ ink, height = 64 } = {}) {
  const width = +((height * LOCKUP_W) / 64).toFixed(1);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${LOCKUP_W} 64" role="img" aria-label="Kept"><title>Kept</title>`,
    markArt(),
    `<g fill="${ink}">${WORDMARK}</g>`,
    '</svg>',
  ].join('');
}

/** Writes beside the target and renames into place, so a tracked file is never half-written. */
function write(rel, data) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
  console.log(`wrote ${rel}`);
}

async function png(svg, px, rel) {
  const buf = await sharp(Buffer.from(svg), { density: 72 * (px / 64) })
    .resize(px, px)
    .png({ compressionLevel: 9 })
    .toBuffer();
  write(rel, buf);
}

async function main() {
  const favicon = `${markSvg()}\n`;
  write('apps/web/public/favicon.svg', favicon);
  write('apps/docs/public/favicon.svg', favicon);
  write('apps/docs/src/assets/logo.svg', favicon);
  await png(markSvg(), 32, 'apps/web/public/favicon-32.png');
  await png(markSvg({ bleed: true }), 180, 'apps/web/public/apple-touch-icon.png');
  await png(markSvg({ hole: HOLE }), 192, 'apps/web/public/icon-192.png');
  await png(markSvg({ hole: HOLE }), 512, 'apps/web/public/icon-512.png');
  // Maskable: the platform may cut the icon to a circle of 80% diameter; keep the art inside.
  await png(markSvg({ bleed: true, inset: 0.1 }), 512, 'apps/web/public/icon-maskable-512.png');
  // The README's lockup, in the kit's ink for each GitHub theme (light: --ink; dark: dark --ink).
  write('docs/assets/kept-lockup-light.svg', `${lockupSvg({ ink: '#1C1B19', height: 80 })}\n`);
  write('docs/assets/kept-lockup-dark.svg', `${lockupSvg({ ink: '#F2EFE9', height: 80 })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
