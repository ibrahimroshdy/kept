import { newId } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { originalKey } from './blob-store.js';
import { createUrlSigner, SIGNED_URL_TTL_SECONDS } from './signed-url.js';

// T2 step 5; Q16: every file is fetched through a short-lived signed URL.

const secret = Buffer.alloc(32, 1);
const file = {
  key: originalKey(newId(), newId()),
  disposition: 'inline' as const,
  filename: 'photo.jpg',
  contentType: 'image/jpeg',
};

// Flip the first character: every bit of it is significant. The last base64url character can
// carry padding bits, so swapping it (A↔B) sometimes decodes to the same bytes and still verifies.
function flipFirstChar(s: string): string {
  const first = s[0] === 'A' ? 'B' : 'A';
  return first + s.slice(1);
}

describe('signed file URLs', () => {
  it('verifies its own token, for five minutes by default', () => {
    let now = 1_800_000_000_000;
    const signer = createUrlSigner(secret, { now: () => now });
    const token = signer.sign(file);
    expect(signer.verify(token)).toEqual({
      ...file,
      expiresAt: now / 1000 + SIGNED_URL_TTL_SECONDS,
    });
    expect(SIGNED_URL_TTL_SECONDS).toBe(300);
    now += 299_000;
    expect(signer.verify(token)).not.toBeNull();
  });

  it('refuses an expired token', () => {
    let now = 1_800_000_000_000;
    const signer = createUrlSigner(secret, { now: () => now });
    const token = signer.sign(file, 60);
    now += 60_000;
    expect(signer.verify(token)).toBeNull();
  });

  it('refuses a tampered payload or signature', () => {
    const signer = createUrlSigner(secret);
    const token = signer.sign(file);
    const [payload, mac] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), d: 'inline' }),
    ).toString('base64url');
    const longer = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        exp: 4_000_000_000,
      }),
    ).toString('base64url');
    expect(signer.verify(`${longer}.${mac}`)).toBeNull();
    expect(signer.verify(`${forged}x.${mac}`)).toBeNull();
    expect(signer.verify(`${payload}.${flipFirstChar(mac)}`)).toBeNull();
    expect(signer.verify(`${payload}.`)).toBeNull();
    expect(signer.verify(payload)).toBeNull();
    expect(signer.verify(`${token}.x`)).toBeNull();
    expect(signer.verify('')).toBeNull();
  });

  it('refuses a token made for another key, and one signed with another secret', () => {
    const signer = createUrlSigner(secret);
    const other = { ...file, key: originalKey(newId(), newId()) };
    const a = signer.sign(file);
    const b = signer.sign(other);
    // B's payload with A's signature: the key is covered by the MAC.
    expect(signer.verify(`${b.split('.')[0]}.${a.split('.')[1]}`)).toBeNull();
    // The route may also pin the key it expects.
    expect(signer.verify(a, { key: other.key })).toBeNull();
    expect(signer.verify(a, { key: file.key })).not.toBeNull();
    expect(createUrlSigner(Buffer.alloc(32, 2)).verify(a)).toBeNull();
  });

  it('refuses to sign a key that is not an id-built key, or a lifetime over a day', () => {
    const signer = createUrlSigner(secret);
    expect(() => signer.sign({ ...file, key: '../secrets.json' })).toThrow(/key/);
    expect(() => signer.sign(file, 0)).toThrow(/lifetime/);
    expect(() => signer.sign(file, 86_401)).toThrow(/lifetime/);
  });
});
