// The report renderer's child process (D201; spike V34): Typst, through the napi addon
// @myriaddreamin/typst-ts-node-compiler, run in a process of its own so that its memory (outside
// V8, so no heap limit reaches it) is bounded by the parent's watch and handed back when it exits
// (render.ts). Plain JavaScript on purpose: it is forked as it is, from src/ in tests and from
// dist/ in the image (build-assets.ts copies it), with no loader.
//
//   node child.mjs <jobDir> <template.typ> <fontDir>
//
// <jobDir> holds data.json, thumbs/*.jpg and qr/*.svg, written by the parent. They are mapped
// into the compiler's virtual file system at /data.json, /thumbs/… and /qr/…; the workspace is
// the job directory, so the template reaches nothing else on disk. The PDF is written to
// <jobDir>/out.pdf and one JSON line goes to stdout. On a Typst error the diagnostics' messages
// (the template's, never the data) go to stderr and the exit code is 3.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';

const [dir, templatePath, fontDir] = process.argv.slice(2);
if (!dir || !templatePath || !fontDir) {
  process.stderr.write('usage: child.mjs <jobDir> <template.typ> <fontDir>\n');
  process.exit(2);
}

const started = performance.now();
const compiler = NodeCompiler.create({ workspace: dir, fontArgs: [{ fontPaths: [fontDir] }] });
compiler.mapShadow(path.join(dir, 'data.json'), readFileSync(path.join(dir, 'data.json')));
for (const sub of ['thumbs', 'qr']) {
  let names = [];
  try {
    names = readdirSync(path.join(dir, sub));
  } catch {
    // None of this kind (no photos, or no QR codes asked for).
  }
  for (const name of names) {
    compiler.mapShadow(path.join(dir, sub, name), readFileSync(path.join(dir, sub, name)));
  }
}
const result = compiler.compile({ mainFileContent: readFileSync(templatePath, 'utf8') });
if (result.hasError()) {
  const diagnostics = compiler.fetchDiagnostics(result.takeDiagnostics()) ?? [];
  for (const d of diagnostics) process.stderr.write(`${String(d?.message ?? d).slice(0, 300)}\n`);
  process.exit(3);
}
const pdf = compiler.pdf(result.result, { creationTimestamp: Math.floor(Date.now() / 1000) });
writeFileSync(path.join(dir, 'out.pdf'), pdf);
process.stdout.write(
  `${JSON.stringify({ ms: Math.round(performance.now() - started), bytes: pdf.length })}\n`,
);
