import { realpathSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot } from '../../package-root.js';
import { buildFonts, fontDir } from './fonts.js';

// The report's build step (D201), run by `pnpm --filter @kept/server build` after tsc:
// - the eight TTFs, converted from the @ibm/plex-* devDependencies into assets/fonts (fonts.ts);
// - the files tsc doesn't emit, copied beside the compiled modules that load them: the child
//   renderer (child.mjs, plain JavaScript), the Typst templates (report.typ, insurance.typ,
//   vehicle.typ), and the PDF text
//   reader's child (files/pdf-worker.mjs, T21).
// The Dockerfile copies assets/ and dist/ into the image.

export async function buildReportAssets(): Promise<void> {
  const root = packageRoot(import.meta.url);
  await buildFonts(fontDir());
  const copies: [string, string][] = [
    ['src/reports/render/child.mjs', 'dist/reports/render/child.mjs'],
    ['src/reports/template/report.typ', 'dist/reports/template/report.typ'],
    ['src/reports/template/insurance.typ', 'dist/reports/template/insurance.typ'],
    ['src/reports/template/vehicle.typ', 'dist/reports/template/vehicle.typ'],
    ['src/files/pdf-worker.mjs', 'dist/files/pdf-worker.mjs'],
  ];
  for (const [from, to] of copies) {
    await mkdir(path.dirname(path.join(root, to)), { recursive: true });
    await copyFile(path.join(root, from), path.join(root, to));
  }
}

// Only as the process entrypoint (`node dist/reports/render/build-assets.js`), not on import.
const argv1 = process.argv[1];
if (argv1 && pathToFileURL(realpathSync(argv1)).href === import.meta.url) {
  await buildReportAssets();
  process.stdout.write('report assets: fonts, child renderer and template\n');
}
