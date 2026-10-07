// WOFF 1.0 -> sfnt (TTF/OTF). WOFF 1 is a lossless container: each table is zlib-compressed
// (or stored) and the original checksums are kept, so decoding gives the original font bytes.
// Needed because Typst reads only TTF/OTF, and the IBM Plex packages on npm ship WOFF/WOFF2 only.
import { inflateSync } from 'node:zlib';

export function woffToSfnt(woff) {
  if (woff.readUInt32BE(0) !== 0x774f4646) throw new Error('not a WOFF 1.0 file');
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    tables.push({
      tag: woff.readUInt32BE(o),
      offset: woff.readUInt32BE(o + 4),
      compLength: woff.readUInt32BE(o + 8),
      origLength: woff.readUInt32BE(o + 12),
      checksum: woff.readUInt32BE(o + 16),
    });
  }
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) { searchRange *= 2; entrySelector++; }
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
    const d = datas[i];
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
