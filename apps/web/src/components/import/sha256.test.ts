import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HASH_CHUNK, hashBlob, Sha256 } from './sha256';

const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('the chunked SHA-256', () => {
  it('matches the FIPS vectors', () => {
    expect(new Sha256().hex()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(new Sha256().update(new TextEncoder().encode('abc')).hex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches Node for every length around the padding boundaries, in uneven pieces', () => {
    for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 4097]) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
      const h = new Sha256();
      for (let i = 0; i < n; i += 13) h.update(data.subarray(i, i + 13));
      expect(h.hex(), `length ${n}`).toBe(node(data));
    }
  });

  it('hashes a file across chunks, reporting progress up to 1', async () => {
    const data = Uint8Array.from({ length: HASH_CHUNK + 1234 }, (_, i) => i & 0xff);
    const seen: number[] = [];
    expect(await hashBlob(new Blob([data]), (f) => seen.push(f))).toBe(node(data));
    expect(seen.at(-1)).toBe(1);
    expect(seen).toHaveLength(2);
  });
});
