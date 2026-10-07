import { crc32, deflateRawSync } from 'node:zlib';

// Hostile ZIPs made byte by byte in the tests (spike Z1's gen_hostile.py, in TypeScript), never
// downloaded. A writer library refuses most of what these need (a `..` name, a duplicate, a
// symlink's mode, a lying size, the encryption flag), so the records are written here: the
// local header, the central directory and the end record of APPNOTE 4.3, nothing more.

export type ForgedEntry = {
  name: string;
  data?: Buffer;
  /** 0 stored, 8 deflated (the data is deflated here). */
  method?: 0 | 8;
  /** Overrides the uncompressed size in both headers (a lie). */
  declaredSize?: number;
  /** General-purpose flags; bit 0 is "encrypted". */
  flags?: number;
  /** `versionMadeBy`'s high byte: 3 is Unix. */
  madeBy?: number;
  /** The Unix mode, written into the external attributes' high half. */
  unixMode?: number;
};

const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** A ZIP of `entries`, in order. */
export function forgeZip(entries: readonly ForgedEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name, 'utf8');
    const size = e.declaredSize ?? data.length;
    const flags = (e.flags ?? 0) | 0x0800; // bit 11: the name is UTF-8
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((e.madeBy ?? 0) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.unixMode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  if (entries.length <= 0xffff) {
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    return Buffer.concat([...locals, directory, end]);
  }
  // ZIP64 by entry count: the ZIP64 end record and its locator before the classic end record,
  // whose count says 0xffff ("look in the ZIP64 record").
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0);
  end64.writeBigUInt64LE(44n, 4);
  end64.writeUInt16LE(45, 12);
  end64.writeUInt16LE(45, 14);
  end64.writeBigUInt64LE(BigInt(entries.length), 24);
  end64.writeBigUInt64LE(BigInt(entries.length), 32);
  end64.writeBigUInt64LE(BigInt(directory.length), 40);
  end64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([...locals, directory, end64, locator, end]);
}
