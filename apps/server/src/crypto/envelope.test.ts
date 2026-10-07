import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type Aad,
  CryptoError,
  generateKey,
  type Keyring,
  open,
  rewrap,
  type Sealed,
  seal,
} from './envelope.js';

const key1 = randomBytes(32);
const key2 = randomBytes(32);
const master1 = { key: key1, keyVersion: 1 };
const master2 = { key: key2, keyVersion: 2 };
const ring: Keyring = new Map([[1, key1]]);
const aad: Aad = {
  table: 'secret_values',
  rowId: '01926f3a-0000-7000-8000-000000000001',
  fieldKey: 'wifi_password',
};

const b64 = (s: string) => Buffer.from(s, 'base64');
const flipByte = (s: string, at = 0) => {
  const buf = b64(s);
  buf[at] = (buf[at] ?? 0) ^ 0x01;
  return buf.toString('base64');
};

function expectCode(fn: () => unknown, code: CryptoError['code']) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CryptoError);
    expect((err as CryptoError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, nothing was thrown`);
}

describe('seal / open', () => {
  it('round-trips a string and bytes', () => {
    expect(open(ring, seal(master1, 'hunter2', aad), aad).toString('utf8')).toBe('hunter2');
    const bytes = randomBytes(100);
    expect(open(ring, seal(master1, bytes, aad), aad).equals(bytes)).toBe(true);
    expect(open(ring, seal(master1, '', aad), aad).length).toBe(0);
  });

  it('produces the stable JSON-safe shape {v:1, kv, dek, iv, ct, tag}', () => {
    const sealed = seal(master1, 'hunter2', aad);
    expect(Object.keys(sealed).sort()).toEqual(['ct', 'dek', 'iv', 'kv', 'tag', 'v']);
    expect(sealed.v).toBe(1);
    expect(sealed.kv).toBe(1);
    expect(b64(sealed.iv).length).toBe(12);
    expect(b64(sealed.tag).length).toBe(16);
    // dek = iv(12) ‖ wrapped key(32) ‖ tag(16)
    expect(b64(sealed.dek).length).toBe(60);
    expect(b64(sealed.ct).toString('utf8')).not.toContain('hunter2');
    expect(JSON.parse(JSON.stringify(sealed))).toEqual(sealed);
  });

  it('uses a fresh data key and IV every time', () => {
    const a = seal(master1, 'same', aad);
    const b = seal(master1, 'same', aad);
    expect(a.dek).not.toBe(b.dek);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('refuses a ciphertext moved to another row, table or field (crypto_aad_mismatch)', () => {
    const sealed = seal(master1, 'hunter2', aad);
    expectCode(
      () => open(ring, sealed, { ...aad, rowId: '01926f3a-0000-7000-8000-000000000002' }),
      'crypto_aad_mismatch',
    );
    expectCode(() => open(ring, sealed, { ...aad, table: 'ai_keys' }), 'crypto_aad_mismatch');
    expectCode(() => open(ring, sealed, { ...aad, fieldKey: 'alarm_code' }), 'crypto_aad_mismatch');
  });

  it('refuses a ciphertext whose content key was moved from another row', () => {
    const other = seal(master1, 'other', { ...aad, rowId: '01926f3a-0000-7000-8000-00000000000f' });
    const sealed = seal(master1, 'hunter2', aad);
    expectCode(() => open(ring, { ...sealed, dek: other.dek }, aad), 'crypto_aad_mismatch');
  });

  it('throws when any part is tampered with', () => {
    const sealed = seal(master1, 'hunter2', aad);
    for (const field of ['ct', 'iv', 'tag', 'dek'] as const) {
      const tampered: Sealed = { ...sealed, [field]: flipByte(sealed[field]) };
      expectCode(() => open(ring, tampered, aad), 'crypto_aad_mismatch');
    }
    // the last byte of the wrapped key too (its GCM tag)
    expectCode(
      () => open(ring, { ...sealed, dek: flipByte(sealed.dek, 59) }, aad),
      'crypto_aad_mismatch',
    );
  });

  it('refuses the wrong master key', () => {
    const sealed = seal(master1, 'hunter2', aad);
    expectCode(() => open(new Map([[1, key2]]), sealed, aad), 'crypto_aad_mismatch');
  });

  it('names a missing key version (crypto_key_missing)', () => {
    const sealed = seal(master2, 'hunter2', aad);
    expectCode(() => open(ring, sealed, aad), 'crypto_key_missing');
  });

  it('rejects a malformed sealed value (crypto_format)', () => {
    const sealed = seal(master1, 'hunter2', aad);
    const bad: unknown[] = [
      { ...sealed, v: 2 },
      { ...sealed, kv: 0 },
      { ...sealed, kv: 1.5 },
      { ...sealed, iv: b64(sealed.iv).subarray(0, 8).toString('base64') },
      { ...sealed, tag: '' },
      { ...sealed, dek: 'not base64!' },
      { ...sealed, ct: undefined },
      null,
      'a string',
    ];
    for (const value of bad) expectCode(() => open(ring, value as Sealed, aad), 'crypto_format');
  });

  it('rejects a master key under 32 bytes and a bad key version (crypto_key_invalid)', () => {
    expectCode(() => seal({ key: randomBytes(16), keyVersion: 1 }, 'x', aad), 'crypto_key_invalid');
    expectCode(() => seal({ key: key1, keyVersion: 0 }, 'x', aad), 'crypto_key_invalid');
  });

  it('accepts a master key longer than 32 bytes (the env contract allows it)', () => {
    const long = randomBytes(48);
    const sealed = seal({ key: long, keyVersion: 1 }, 'hunter2', aad);
    expect(open(new Map([[1, long]]), sealed, aad).toString()).toBe('hunter2');
  });

  it("rejects an AAD part containing '|', which would make the binding ambiguous", () => {
    expectCode(() => seal(master1, 'x', { ...aad, table: 'a|b' }), 'crypto_aad_invalid');
    expectCode(() => seal(master1, 'x', { ...aad, fieldKey: '' }), 'crypto_aad_invalid');
  });
});

describe('rewrap', () => {
  it('keeps the plaintext and the content ciphertext, and moves to the new key version', () => {
    const sealed = seal(master1, 'hunter2', aad);
    const moved = rewrap(sealed, ring, master2, aad);
    expect(moved.kv).toBe(2);
    expect(moved.ct).toBe(sealed.ct);
    expect(moved.iv).toBe(sealed.iv);
    expect(moved.tag).toBe(sealed.tag);
    expect(moved.dek).not.toBe(sealed.dek);
    expect(open(new Map([[2, key2]]), moved, aad).toString()).toBe('hunter2');
    expectCode(() => open(ring, moved, aad), 'crypto_key_missing');
  });

  it('refuses to rewrap under the wrong row', () => {
    const sealed = seal(master1, 'hunter2', aad);
    expectCode(
      () =>
        rewrap(sealed, ring, master2, { ...aad, rowId: '01926f3a-0000-7000-8000-000000000002' }),
      'crypto_aad_mismatch',
    );
  });
});

describe('generateKey', () => {
  it('returns 32 random bytes as canonical unpadded base64url', () => {
    const key = generateKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key, 'base64url').length).toBe(32);
    expect(Buffer.from(key, 'base64url').toString('base64url')).toBe(key);
    expect(generateKey()).not.toBe(key);
  });
});
