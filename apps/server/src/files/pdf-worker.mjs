// The PDF text reader's child process (plan T21, Q19; D77, D157; engineering spec §3.1b). A PDF
// is a hostile file until proven otherwise, so its parse runs here, in a process of its own that
// the parent (pdf-text.ts) kills past 20 s of wall-clock time or 256 MB of resident memory; it
// starts this file with `--max-old-space-size=256` and an empty environment. Plain JavaScript on
// purpose, as the report's child.mjs is: it is started as it is, from src/ in tests and from
// dist/ in the image (reports/render/build-assets.ts copies it), with no loader.
//
//   node --max-old-space-size=256 pdf-worker.mjs <file.pdf> <maxChars>
//
// The parser is unpdf's build of PDF.js (unpdf MIT, PDF.js Apache-2.0): pure JavaScript, no
// native code, no eval, the same on amd64 and arm64. Pages are read in order and the reading
// stops once `maxChars` characters are in hand, so a long document costs no more than its first
// pages. Only text is read: no images are decoded, no fonts are loaded from the system, and
// nothing is rendered.
//
// Exit codes, with one JSON line on stdout for 0:
//   0  {"pages", "read", "text", "truncated"}: `text` is what the pages said, maybe empty (a scan)
//   2  usage
//   3  the file isn't a PDF PDF.js can read (stderr: the parser's message, never the text)
//   4  the PDF is encrypted with a password
import { readFileSync } from 'node:fs';
import { getDocumentProxy } from 'unpdf';

/** PDF.js's own exception names (PasswordException, InvalidPDFException…). */
const nameOf = (e) => (e && typeof e === 'object' && 'name' in e ? String(e.name) : '');

async function main(file, maxChars) {
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(readFileSync(file)), {
      useSystemFonts: false,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      enableXfa: false,
      stopAtErrors: false,
      verbosity: 0,
    });
  } catch (e) {
    if (nameOf(e) === 'PasswordException') return 4;
    process.stderr.write(`${nameOf(e) || 'Error'}: ${String(e?.message ?? e).slice(0, 300)}\n`);
    return 3;
  }

  const parts = [];
  let length = 0;
  let read = 0;
  for (let n = 1; n <= doc.numPages && length < maxChars; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      text += item.str;
      text += item.hasEOL ? '\n' : ' ';
    }
    page.cleanup();
    read = n;
    text = text.replace(/[ \t]+\n/g, '\n').trim();
    if (text === '') continue;
    parts.push(text);
    length += text.length + 2;
  }
  const pages = doc.numPages;
  await doc.loadingTask.destroy();

  const all = parts.join('\n\n');
  process.stdout.write(
    `${JSON.stringify({
      pages,
      read,
      text: all.slice(0, maxChars),
      truncated: all.length > maxChars || read < pages,
    })}\n`,
  );
  return 0;
}

const [file, maxArg] = process.argv.slice(2);
const maxChars = Number(maxArg);
if (!file || !Number.isInteger(maxChars) || maxChars < 1) {
  process.stderr.write('usage: pdf-worker.mjs <file.pdf> <maxChars>\n');
  process.exitCode = 2;
} else {
  // Set, not exit(): a pipe to the parent may still be flushing what was written.
  process.exitCode = await main(file, maxChars);
}
