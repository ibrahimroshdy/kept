// Generates the untracked inputs: TTF fonts (from @ibm/plex-* WOFF) and 30 sample thumbnails.
// Thumbnails are 200 px (15 mm printed at ~340 dpi): the derivative a report needs, not the photo.
// Usage: node prepare.mjs   (needs ImageMagick's `magick` on PATH for the thumbnails)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { woffToSfnt } from './lib/woff-to-ttf.mjs';

const here = new URL('.', import.meta.url).pathname;
mkdirSync(`${here}fonts`, { recursive: true });
const fonts = [
  ['@ibm/plex-sans', 'IBMPlexSans', ['Regular', 'Medium', 'SemiBold']],
  ['@ibm/plex-sans-arabic', 'IBMPlexSansArabic', ['Regular', 'Medium', 'SemiBold']],
  ['@ibm/plex-mono', 'IBMPlexMono', ['Regular', 'SemiBold']],
];
for (const [pkg, base, weights] of fonts) {
  for (const w of weights) {
    const src = `${here}node_modules/${pkg}/fonts/complete/woff/${base}-${w}.woff`;
    writeFileSync(`${here}fonts/${base}-${w}.ttf`, woffToSfnt(readFileSync(src)));
  }
}
console.log('fonts ok');

mkdirSync(`${here}sample/thumbs`, { recursive: true });
const palette = ['#c9b79c-#6b5a45', '#9fb4c7-#2f4858', '#d6c38b-#7a5c1e', '#b7c9a8-#3f5a36', '#c7a9a0-#6e3b2e', '#bdbdbd-#3a3a3a'];
// 250 unique thumbnails: 30 for the sample, all 250 for the 500-thing budget run, which also uses
// a WebP copy of every third one (Kept's display derivatives may be WebP).
for (let i = 0; i < 250; i++) {
  const out = `${here}sample/thumbs/t${String(i).padStart(3, '0')}.jpg`;
  if (existsSync(out)) continue;
  execFileSync('magick', [
    '-seed', String(100 + i), '-size', '200x200', `plasma:${palette[i % palette.length]}`,
    '-blur', '0x3', '-fill', 'rgba(255,255,255,0.35)', '-draw', `circle 100,100 100,${44 + (i % 5) * 8}`,
    '-quality', '72', out,
  ]);
  if (i % 3 === 0) execFileSync('magick', [out, '-quality', '72', out.replace(/jpg$/, 'webp')]);
}
console.log('thumbs ok');
