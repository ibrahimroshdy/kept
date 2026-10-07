// Step-4 spike T0 (step-2 Q9, D157, D172): does stock sharp 0.35.4 rasterise an SVG brand logo
// without touching the network or the disk? A local HTTP recorder stands in for any server an
// SVG might name; every external reference points at it. Run: node run.mjs (from this directory).
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, '../../../../../apps/server/package.json'));
const scratch = mkdtempSync(path.join(tmpdir(), 'kept-svg-'));
const sharp = require('sharp');
const hits = [];
const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, {'content-type': req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.svg') ? 'image/svg+xml' : 'image/png'}); res.end(req.url.endsWith('.css') ? 'rect{fill:red}' : req.url.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg"><rect id="a" width="10" height="10" fill="red"/></svg>' : Buffer.alloc(0)); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const U = (p) => `http://127.0.0.1:${port}${p}`;
// A tiny local red PNG, to see whether a file: href is read.
const red = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
const redPath = path.join(scratch, 'red.png');
writeFileSync(redPath, red);
const svg = (inner, w = 64, h = 64) => Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 64 64"><rect width="64" height="64" fill="#fff"/>${inner}</svg>`);
const cases = {
  plain: svg('<circle cx="32" cy="32" r="20" fill="#0a0"/>'),
  imageHttp: svg(`<image href="${U('/img.png')}" width="64" height="64"/>`),
  imageXlinkHttp: svg(`<image xlink:href="${U('/xlink.png')}" width="64" height="64"/>`),
  useHttp: svg(`<use href="${U('/sprite.svg')}#a"/>`),
  cssImport: svg(`<style>@import url("${U('/x.css')}");</style><rect width="64" height="64"/>`),
  cssUrlFill: svg(`<rect width="64" height="64" style="fill:url(${U('/grad.svg')}#g)"/>`),
  feImage: svg(`<filter id="f"><feImage href="${U('/fe.png')}"/></filter><rect width="64" height="64" filter="url(#f)"/>`),
  imageFile: svg(`<image href="file://${redPath}" width="64" height="64"/>`),
  imageRelative: svg(`<image href="red.png" width="64" height="64"/>`),
  xinclude: svg(`<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="${U('/xi.svg')}"/>`),
  entityExternal: Buffer.from(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY ext SYSTEM "${U('/ent.txt')}">]><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text y="20">&ext;</text></svg>`),
  laughs: Buffer.from(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;"><!ENTITY g "&f;&f;&f;&f;&f;&f;&f;&f;&f;&f;"><!ENTITY h "&g;&g;&g;&g;&g;&g;&g;&g;&g;&g;">]><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text y="20">&h;</text></svg>`),
  huge: svg('<rect width="64" height="64"/>', 100000, 100000),
};
let els = '';
for (let i = 0; i < 4000; i++) els += `<path d="M${i % 64} ${(i * 7) % 64} l3 3 l-2 1 z" fill="#${(i * 2654435761 % 0xffffff).toString(16).padStart(6, '0')}"/>`;
cases.elements4000 = svg(els, 512, 512);
const opts = { limitInputPixels: 4096 * 4096, density: 72 };
for (const [name, buf] of Object.entries(cases)) {
  const before = hits.length;
  const t0 = performance.now();
  let out;
  try {
    const { data, info } = await sharp(buf, opts).resize(256, 256, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
    const { data: px } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
    out = `ok png ${info.width}x${info.height} ${data.length}B centre=${[...px.subarray(((info.height>>1)*info.width+(info.width>>1))*4, ((info.height>>1)*info.width+(info.width>>1))*4+3)].join(',')}`;
  } catch (e) { out = `error: ${String(e.message).slice(0, 120)}`; }
  const ms = (performance.now() - t0).toFixed(1);
  await new Promise((r) => setTimeout(r, 150));
  console.log(`${name.padEnd(15)} ${ms.padStart(7)} ms  requests=${hits.length - before}  ${out}`);
}
// Timing of the 4000-element case, warm, 5 runs.
const times = [];
for (let i = 0; i < 5; i++) { const t0 = performance.now(); await sharp(cases.elements4000, opts).resize(256, 256, { fit: 'inside' }).png().toBuffer(); times.push(performance.now() - t0); }
console.log('elements4000 warm ms', times.map((t) => t.toFixed(1)).join(' '), 'bytes', cases.elements4000.length);
console.log('all requests seen:', JSON.stringify(hits));
console.log('librsvg', sharp.versions.rsvg, 'vips', sharp.versions.vips);
rmSync(scratch, { recursive: true, force: true });
srv.close();
