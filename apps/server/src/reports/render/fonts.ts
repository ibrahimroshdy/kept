import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { packageRoot } from '../../package-root.js';

// The report's fonts (D201; spike V34): IBM Plex Sans, Sans Arabic and Mono, the fonts the web
// ships. Typst reads only TTF/OTF, and IBM publishes Plex on npm as WOFF/WOFF2 only, so the eight
// faces the template uses are converted at build time (`pnpm --filter @kept/server build` runs
// build-assets.ts) from the pinned devDependencies @ibm/plex-sans@1.1.0,
// @ibm/plex-sans-arabic@1.1.0 and @ibm/plex-mono@2.5.0 into `assets/fonts/`, with the OFL text.
// They are generated, not committed: the repository stays free of binaries, the versions are the
// lockfile's, and check-licences.mjs sees them like any dependency. The image copies the
// directory (Dockerfile); in the repo, a test or a dev server that finds it empty generates it
// once from node_modules (ensureFonts()).

/** `[package, file base name, weights]`: exactly the faces report.typ asks for. */
const FACES = [
  ['@ibm/plex-sans', 'IBMPlexSans', ['Regular', 'Medium', 'SemiBold']],
  ['@ibm/plex-sans-arabic', 'IBMPlexSansArabic', ['Regular', 'Medium', 'SemiBold']],
  ['@ibm/plex-mono', 'IBMPlexMono', ['Regular', 'SemiBold']],
] as const;

export const FONT_FILES: readonly string[] = FACES.flatMap(([, base, weights]) =>
  weights.map((w) => `${base}-${w}.ttf`),
);

/** Where the TTFs live: `<package>/assets/fonts`, in the repo and in the image alike. */
export function fontDir(): string {
  return path.join(packageRoot(import.meta.url), 'assets', 'fonts');
}

export class FontsMissingError extends Error {
  constructor(dir: string) {
    super(
      `the report fonts are missing from ${dir}; run \`pnpm --filter @kept/server build\` (it converts them from @ibm/plex-*)`,
    );
    this.name = 'FontsMissingError';
  }
}

/**
 * WOFF 1.0 → sfnt (TTF). WOFF 1 is a lossless container: each table is zlib-compressed (or
 * stored) with its original checksum, so decoding restores the original font bytes exactly.
 */
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.readUInt32BE(0) !== 0x774f4646) throw new Error('not a WOFF 1.0 file');
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables = Array.from({ length: numTables }, (_, i) => {
    const o = 44 + i * 20;
    return {
      tag: woff.readUInt32BE(o),
      offset: woff.readUInt32BE(o + 4),
      compLength: woff.readUInt32BE(o + 8),
      origLength: woff.readUInt32BE(o + 12),
      checksum: woff.readUInt32BE(o + 16),
    };
  });
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) {
    searchRange *= 2;
    entrySelector++;
  }
  searchRange *= 16;
  const headerLen = 12 + 16 * numTables;
  const datas = tables.map((t) => {
    const raw = woff.subarray(t.offset, t.offset + t.compLength);
    return t.compLength < t.origLength ? inflateSync(raw) : Buffer.from(raw);
  });
  let total = headerLen;
  for (const d of datas) total += (d.length + 3) & ~3;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);
  let off = headerLen;
  tables.forEach((t, i) => {
    const d = datas[i] as Buffer;
    const e = 12 + i * 16;
    out.writeUInt32BE(t.tag, e);
    out.writeUInt32BE(t.checksum, e + 4);
    out.writeUInt32BE(off, e + 8);
    out.writeUInt32BE(t.origLength, e + 12);
    d.copy(out, off);
    off += (d.length + 3) & ~3;
  });
  return out;
}

const hasAll = (dir: string) => FONT_FILES.every((f) => existsSync(path.join(dir, f)));

/** Converts the eight faces from the @ibm/plex-* packages into `dir`, with the OFL text. Each
 * file is written under a temp name and renamed, so a reader never sees half a font. */
export async function buildFonts(dir: string = fontDir()): Promise<void> {
  const require = createRequire(import.meta.url);
  await mkdir(dir, { recursive: true });
  for (const [pkg, base, weights] of FACES) {
    const root = path.dirname(require.resolve(`${pkg}/package.json`));
    for (const w of weights) {
      const woff = await readFile(
        path.join(root, 'fonts', 'complete', 'woff', `${base}-${w}.woff`),
      );
      const dest = path.join(dir, `${base}-${w}.ttf`);
      const tmp = `${dest}.${process.pid}.tmp`;
      await writeFile(tmp, woffToSfnt(woff));
      await rename(tmp, dest);
    }
    await copyFile(path.join(root, 'LICENSE.txt'), path.join(dir, `${base}-OFL.txt`));
  }
}

let ready: Promise<string> | null = null;

/** The font directory, with the eight TTFs in it: generated once from node_modules when missing
 * (the repo), a FontsMissingError when they can't be (an image built without them). */
export function ensureFonts(dir: string = fontDir()): Promise<string> {
  if (hasAll(dir)) return Promise.resolve(dir);
  ready ??= buildFonts(dir).then(
    () => dir,
    (err: unknown) => {
      ready = null;
      throw Object.assign(new FontsMissingError(dir), { cause: err });
    },
  );
  return ready;
}
