/**
 * An archive's SHA-256, read in chunks (plan T19 step 2). `crypto.subtle.digest` takes the whole
 * input at once, so a 5 GB archive would have to sit in memory; this is the same function
 * (FIPS 180-4), fed 4 MiB at a time. It runs in a worker (sha256.worker.ts) so the page stays
 * responsive; the server compares the result with the bytes it stored (`X-Kept-Sha256`).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly w = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private length = 0;

  update(data: Uint8Array): this {
    this.length += data.length;
    let i = 0;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      i = take;
      if (this.blockLen < 64) return this;
      this.compress(new DataView(this.block.buffer), 0);
      this.blockLen = 0;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (; i + 64 <= data.length; i += 64) this.compress(view, i);
    if (i < data.length) {
      this.block.set(data.subarray(i));
      this.blockLen = data.length - i;
    }
    return this;
  }

  /** The digest as 64 lower-case hex characters. The hash can't be updated afterwards. */
  hex(): string {
    const bits = this.length * 8;
    const tail = new Uint8Array(this.blockLen < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.blockLen));
    tail[this.blockLen] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(tail.length - 4, bits >>> 0);
    for (let i = 0; i < tail.length; i += 64) this.compress(view, i);
    return Array.from(this.h, (x) => x.toString(16).padStart(8, '0')).join('');
  }

  private compress(view: DataView, offset: number) {
    const w = this.w;
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15] as number;
      const b = w[t - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0;
    }
    const h = this.h;
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[t] as number) + (w[t] as number)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + b;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + hh;
  }
}

/** Bytes read per step. */
export const HASH_CHUNK = 4 * 1024 ** 2;

/** Hashes a file chunk by chunk, telling `onProgress` the fraction read. */
export async function hashBlob(
  blob: Blob,
  onProgress: (fraction: number) => void = () => {},
): Promise<string> {
  const hash = new Sha256();
  for (let at = 0; at < blob.size; at += HASH_CHUNK) {
    const chunk = blob.slice(at, Math.min(blob.size, at + HASH_CHUNK));
    hash.update(new Uint8Array(await chunk.arrayBuffer()));
    onProgress(Math.min(1, (at + HASH_CHUNK) / blob.size));
  }
  return hash.hex();
}

export type HashMessage =
  | { kind: 'progress'; fraction: number }
  | { kind: 'done'; sha256: string }
  | { kind: 'error' };

/**
 * The file's SHA-256, in a worker where there is one (sha256.worker.ts), else here. Rejects when
 * the file can't be read (it was moved or deleted after it was chosen).
 */
export function hashFile(file: Blob, onProgress: (fraction: number) => void): Promise<string> {
  if (typeof Worker === 'undefined') return hashBlob(file, onProgress);
  const worker = new Worker(new URL('./sha256.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<string>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<HashMessage>) => {
      if (e.data.kind === 'progress') onProgress(e.data.fraction);
      else {
        worker.terminate();
        if (e.data.kind === 'done') resolve(e.data.sha256);
        else reject(new Error('unreadable'));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('unreadable'));
    };
    worker.postMessage(file);
  });
}
