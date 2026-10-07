/**
 * The app lock's keys (step-8 plan T23; spike L1). PBKDF2 runs at a small count here: the count
 * is stored with each wrap, so the code path is the same as the device's 2,850,000. WebAuthn is a
 * stub (agent rules: never a real authenticator): `navigator.credentials` answers with or without
 * a PRF secret, the two cases L1 found.
 */
import { APP_LOCK } from '@kept/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changePin,
  createLock,
  enrolPasskey,
  seal,
  sealJson,
  sha256Hex,
  unlockWithPasskey,
  unlockWithPin,
  unseal,
  unsealJson,
  validPin,
} from './lock';

const FAST = 1000;

describe('the PIN', () => {
  it('accepts 6 to 12 digits only', async () => {
    expect(validPin('123456')).toBe(true);
    expect(validPin('123456789012')).toBe(true);
    expect(validPin('12345')).toBe(false);
    expect(validPin('1234567890123')).toBe(false);
    expect(validPin('12345a')).toBe(false);
    await expect(createLock('12345', FAST)).rejects.toThrow();
  });

  it('wraps a data key it alone unwraps, with its salt and count stored', async () => {
    const { record, dataKey } = await createLock('482913', FAST);
    expect(record).toMatchObject({ v: 1, pinLength: 6, failedTries: 0, passkey: null });
    expect(record.pin.iterations).toBe(FAST);
    expect(record.pin.wrapped.byteLength).toBe(40);
    const again = await unlockWithPin(record, '482913');
    expect(again).not.toBeNull();
    const sealed = await sealJson(dataKey, 'extra:t1', { price: '4999.5' });
    expect(await unsealJson(again as CryptoKey, 'extra:t1', sealed)).toEqual({ price: '4999.5' });
    expect(await unlockWithPin(record, '482914')).toBeNull();
    expect(await unlockWithPin(record, 'abcdef')).toBeNull();
  });

  it('uses the spike’s count by default', () => {
    expect(APP_LOCK.pbkdf2Iterations).toBe(2_850_000);
  });

  it('keeps the same data key under a new PIN', async () => {
    const { record, dataKey } = await createLock('482913', FAST);
    const sealed = await sealJson(dataKey, 'extra:t1', 'kept');
    const next = await changePin({ ...record, failedTries: 3 }, dataKey, '11223344', FAST);
    expect(next.pinLength).toBe(8);
    expect(next.failedTries).toBe(0);
    expect(await unlockWithPin(next, '482913')).toBeNull();
    const key = await unlockWithPin(next, '11223344');
    expect(await unsealJson(key as CryptoKey, 'extra:t1', sealed)).toBe('kept');
  });
});

describe('sealing', () => {
  it('binds a row to its id: another row’s id fails', async () => {
    const { dataKey } = await createLock('482913', FAST);
    const bytes = new TextEncoder().encode('receipt bytes');
    const sealed = await seal(dataKey, 'body:a1', bytes);
    expect(new TextDecoder().decode(await unseal(dataKey, 'body:a1', sealed))).toBe(
      'receipt bytes',
    );
    await expect(unseal(dataKey, 'body:a2', sealed)).rejects.toThrow();
  });

  it('hashes as the server does', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer);
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

/** A stub authenticator: a fixed PRF secret per salt, or none. Never a real one. */
function stubCredentials({ prf }: { prf: 'create' | 'get-only' | 'none' }) {
  const secret = new Uint8Array(32).fill(7).buffer;
  const rawId = new Uint8Array([1, 2, 3, 4]).buffer;
  const create = vi.fn(async () => ({
    rawId,
    getClientExtensionResults: () =>
      prf === 'none'
        ? { prf: { enabled: false } }
        : prf === 'create'
          ? { prf: { enabled: true, results: { first: secret } } }
          : { prf: { enabled: true } },
  }));
  const get = vi.fn(async () => ({
    rawId,
    getClientExtensionResults: () =>
      prf === 'none' ? {} : { prf: { results: { first: secret } } },
  }));
  vi.stubGlobal('navigator', { ...globalThis.navigator, credentials: { create, get } });
  return { create, get };
}

afterEach(() => vi.unstubAllGlobals());

describe('the passkey', () => {
  it('with PRF at creation, also opens the data key', async () => {
    const { create, get } = stubCredentials({ prf: 'create' });
    const { record, dataKey } = await createLock('482913', FAST);
    const withKey = await enrolPasskey(record, dataKey, 'Kept app lock');
    expect(create).toHaveBeenCalledOnce();
    const options = (create.mock.calls[0] as unknown as [CredentialCreationOptions])[0].publicKey;
    expect(options?.authenticatorSelection?.userVerification).toBe('required');
    expect(get).not.toHaveBeenCalled();
    expect(withKey.passkey?.wrapped).not.toBeNull();
    const key = await unlockWithPasskey(withKey);
    const sealed = await sealJson(dataKey, 'extra:t', 1);
    expect(await unsealJson(key as CryptoKey, 'extra:t', sealed)).toBe(1);
  });

  it('with the secret only at assertion, asks once more during setup (L1 finding 2)', async () => {
    const { get } = stubCredentials({ prf: 'get-only' });
    const { record, dataKey } = await createLock('482913', FAST);
    const withKey = await enrolPasskey(record, dataKey, 'Kept app lock');
    expect(get).toHaveBeenCalledOnce();
    expect(withKey.passkey?.wrapped).not.toBeNull();
  });

  it('without PRF, unlocks the app but not the data key', async () => {
    stubCredentials({ prf: 'none' });
    const { record, dataKey } = await createLock('482913', FAST);
    const withPasskey = await enrolPasskey(record, dataKey, 'Kept app lock');
    expect(withPasskey.passkey).not.toBeNull();
    expect(withPasskey.passkey?.wrapped).toBeNull();
    expect(await unlockWithPasskey(withPasskey)).toBeNull();
  });

  it('refuses when verification fails', async () => {
    const { get } = stubCredentials({ prf: 'create' });
    const { record, dataKey } = await createLock('482913', FAST);
    const withKey = await enrolPasskey(record, dataKey, 'Kept app lock');
    get.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    await expect(unlockWithPasskey(withKey)).rejects.toThrow();
  });
});
