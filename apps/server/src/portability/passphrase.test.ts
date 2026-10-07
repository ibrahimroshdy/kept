import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixedSecretKeys, keyringOf } from '../crypto/keyring.js';
import {
  checkSecretsFile,
  decryptSecrets,
  deriveKey,
  encryptSecrets,
  type KdfParams,
  keyForSecretsFile,
  newSalt,
  openRunKey,
  PassphraseWrongError,
  SecretsFileError,
  sealRunKey,
} from './passphrase.js';

// A cheaper N than the default keeps the suite fast; the file records whatever was used.
const KDF: KdfParams = { name: 'scrypt', N: 2 ** 14, r: 8, p: 1 };
const keys = fixedSecretKeys(keyringOf({ version: 1, key: randomBytes(32), retired: new Map() }));

describe('passphrase', () => {
  it('derives the same key for the same passphrase and salt, another for another', async () => {
    const salt = newSalt();
    const a = await deriveKey('correct horse battery', salt, KDF);
    expect(a).toHaveLength(32);
    expect((await deriveKey('correct horse battery', salt, KDF)).equals(a)).toBe(true);
    expect((await deriveKey('correct horse batterz', salt, KDF)).equals(a)).toBe(false);
  });

  it('refuses parameters outside the accepted bounds', async () => {
    await expect(deriveKey('x'.repeat(12), newSalt(), { ...KDF, N: 1000 })).rejects.toThrow(
      SecretsFileError,
    );
  });

  it('seals a run key with its salt, bound to the run', async () => {
    const salt = newSalt();
    const key = await deriveKey('correct horse battery', salt, KDF);
    const runId = '01990000-0000-7000-8000-000000000001';
    const sealed = sealRunKey(keys, 'export_runs', runId, key, { salt, kdf: KDF });
    expect(JSON.stringify(sealed)).not.toContain(key.toString('base64url'));
    const opened = await openRunKey(keys, 'export_runs', runId, sealed.ciphertext);
    expect(opened.key.equals(key)).toBe(true);
    expect(opened.salt?.equals(salt)).toBe(true);
    expect(opened.kdf).toEqual(KDF);
    await expect(openRunKey(keys, 'import_runs', runId, sealed.ciphertext)).rejects.toBeInstanceOf(
      Error,
    );
  });

  it('round-trips secrets.json, and a wrong passphrase or another export fails', async () => {
    const salt = newSalt();
    const key = await deriveKey('correct horse battery', salt, KDF);
    const plain = Buffer.from('{"value":"hunter2"}\n', 'utf8');
    const file = checkSecretsFile(
      JSON.parse(JSON.stringify(encryptSecrets(key, { salt, kdf: KDF }, 'exp-1', plain))),
    );
    expect(JSON.stringify(file)).not.toContain('hunter2');
    const again = await keyForSecretsFile('correct horse battery', file);
    expect(decryptSecrets(again, file, 'exp-1').toString('utf8')).toBe(plain.toString('utf8'));
    const wrong = await keyForSecretsFile('wrong horse battery', file);
    expect(() => decryptSecrets(wrong, file, 'exp-1')).toThrow(PassphraseWrongError);
    expect(() => decryptSecrets(again, file, 'exp-2')).toThrow(PassphraseWrongError);
  });

  it('refuses a secrets file Kept does not read', () => {
    expect(() => checkSecretsFile({ format: 'other' })).toThrow(SecretsFileError);
    expect(() =>
      checkSecretsFile({
        format: 'kept-secrets',
        version: 1,
        cipher: 'aes-256-gcm',
        kdf: { name: 'scrypt', N: 3, r: 8, p: 1, salt: 'x' },
        iv: '',
        tag: '',
        data: '',
      }),
    ).toThrow(SecretsFileError);
  });
});
