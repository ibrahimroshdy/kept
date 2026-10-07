/**
 * Z1 writer: yazl writes N MiB of stored (not deflated) JPEG-sized entries through
 * addReadStreamLazy, with `size` given, and reports peak RSS.
 *
 *   node --max-old-space-size=256 z1_write.mjs <total-MiB> <out-file | "-" to discard>
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

const totalMiB = Number(process.argv[2]);
const outPath = process.argv[3];
const ENTRY = 3 * 1024 * 1024 + 12345; // a phone photo's size, deliberately not block-aligned
const count = Math.ceil((totalMiB * 1024 * 1024) / ENTRY);

const pattern = randomBytes(64 * 1024);
pattern[0] = 0xff;
pattern[1] = 0xd8;
pattern[2] = 0xff;
function photo(bytes) {
  let left = bytes;
  return new Readable({
    read() {
      if (left <= 0) return this.push(null);
      const n = Math.min(left, pattern.length);
      left -= n;
      this.push(n === pattern.length ? pattern : pattern.subarray(0, n));
    },
  });
}

let peak = 0;
const sample = () => {
  peak = Math.max(peak, process.memoryUsage().rss);
};
const timer = setInterval(sample, 50);

const zip = new yazl.ZipFile();
const mtime = new Date('2026-09-30T00:00:00Z');
for (let i = 0; i < count; i++) {
  zip.addReadStreamLazy(
    `attachments/${String(i).padStart(6, '0')}.jpg`,
    { compress: false, size: ENTRY, mtime },
    (cb) => cb(null, photo(ENTRY)),
  );
}
zip.addBuffer(Buffer.from('{"format":"kept-export","version":1}\n'), 'manifest.json', { mtime, compress: false });
let predicted = null;
zip.end({}, (n) => {
  predicted = n;
});

let written = 0;
const sink =
  outPath === '-'
    ? new Writable({
        write(chunk, _enc, cb) {
          written += chunk.length;
          cb();
        },
      })
    : createWriteStream(outPath);
if (outPath !== '-') zip.outputStream.on('data', (c) => (written += c.length));

const t0 = performance.now();
await pipeline(zip.outputStream, sink);
clearInterval(timer);
sample();
console.log(
  JSON.stringify({
    entries: count + 1,
    entryBytes: ENTRY,
    predictedTotal: predicted,
    written,
    match: predicted === written,
    peakRssMiB: Math.round(peak / 1048576),
    seconds: Math.round((performance.now() - t0) / 100) / 10,
  }),
);
