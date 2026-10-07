import { describe, expect, it } from 'vitest';
import {
  type KitBackupHalf,
  type RecoveryKitInput,
  recoveryKitFilename,
  renderRecoveryKitHtml,
  renderRecoveryKitText,
  shellQuote,
} from './recovery-kit-content.js';

// Step-8 T9 (D182, Q15): what the recovery kit says, as text and as the printable page.

const base: RecoveryKitInput = {
  generatedAt: new Date('2026-10-06T09:30:00Z'),
  publicUrl: 'https://kept.example',
  version: '1.0.0',
  revision: '3f9ed1d',
  keys: {
    secretKey: 'S'.repeat(43),
    authSecret: 'A'.repeat(43),
    secretKeyVersion: 1,
    retired: undefined,
    source: 'environment',
  },
  backup: { state: 'none' },
};

/** An SFTP target with a long (RSA-sized) private key: the kit must still stay under 200 lines. */
const sftp: KitBackupHalf = {
  state: 'configured',
  backup: {
    kind: 'sftp',
    description: 'SFTP kept@nas.home:/srv/kept',
    repository: 'sftp:kept@nas.home:/srv/kept/restic',
    password: "it's a long backup passphrase",
    environment: [],
    sftp: {
      privateKey: [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        ...Array.from({ length: 49 }, () => 'b'.repeat(70)),
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n'),
      knownHostsLine: 'nas.home ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKey',
    },
    lockedByEnvironment: true,
  },
};

describe('the recovery kit content', () => {
  it('holds the address, the version, the keys and "No backup configured"', () => {
    const text = renderRecoveryKitText(base);
    expect(text).toContain('Instance: https://kept.example');
    expect(text).toContain('Kept: 1.0.0 (revision 3f9ed1d)');
    expect(text).toContain('Made: 2026-10-06T09:30:00.000Z');
    expect(text).toContain(`KEPT_SECRET_KEY=${'S'.repeat(43)}`);
    expect(text).toContain(`KEPT_AUTH_SECRET=${'A'.repeat(43)}`);
    expect(text).toContain("Read from: the server's environment");
    expect(text).not.toContain('KEPT_SECRET_KEY_VERSION');
    expect(text).toContain('No backup configured.');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('after a rotation, holds the version and every retired key', () => {
    const text = renderRecoveryKitText({
      ...base,
      keys: { ...base.keys, secretKeyVersion: 3, retired: '1:aaa,2:bbb', source: '/config/x' },
    });
    expect(text).toContain('KEPT_SECRET_KEY_VERSION=3');
    expect(text).toContain('KEPT_SECRET_KEYS_RETIRED=1:aaa,2:bbb');
    expect(text).toContain('Read from: /config/x');
  });

  it('with SFTP: the key, the pinned host key and the restic commands filled in, under 200 lines', () => {
    const text = renderRecoveryKitText({ ...base, backup: sftp });
    expect(text.split('\n').length).toBeLessThan(200);
    expect(text).toContain('RESTIC_REPOSITORY=sftp:kept@nas.home:/srv/kept/restic');
    expect(text).toContain("set by the server's environment");
    expect(text).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(text).toContain('nas.home ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKey');
    expect(text).toContain(`export RESTIC_PASSWORD='it'\\''s a long backup passphrase'`);
    expect(text).toContain('UserKnownHostsFile=kept-known-hosts');
    expect(text).toContain('--include /backup/readable');
  });

  it('says what is missing when the backup half could not be read', () => {
    const text = renderRecoveryKitText({
      ...base,
      backup: { state: 'unavailable', reason: "the database didn't answer when it was made." },
    });
    expect(text).toContain("Not included: the database didn't answer");
    expect(text).not.toContain('RESTIC_PASSWORD=');
  });

  it('prints as a self-contained page: escaped, no script, nothing remote', () => {
    const html = renderRecoveryKitHtml({
      ...base,
      backup: {
        state: 'configured',
        backup: {
          ...(sftp.state === 'configured' ? sftp.backup : ({} as never)),
          password: '<b>&',
        },
      },
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('RESTIC_PASSWORD=&lt;b&gt;&amp;');
    expect(html).not.toMatch(/<script|<link|<img|src=|href=|@import|url\(/i);
  });

  it('quotes for a shell and names the file by its day', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(recoveryKitFilename(base.generatedAt, 'text')).toBe('kept-recovery-kit-2026-10-06.txt');
    expect(recoveryKitFilename(base.generatedAt, 'html')).toBe('kept-recovery-kit-2026-10-06.html');
  });
});
