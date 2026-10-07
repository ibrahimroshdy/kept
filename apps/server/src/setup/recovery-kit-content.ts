import type { BackupTargetKind, RecoveryKitFormat } from '@kept/shared';
import type { KeyMaterial } from '../config/env.js';

// The recovery kit's content (D66, D165, D182; step-8 plan T9, Q15): everything a burned server
// needs to come back from its backup, as plain text (UTF-8, under 200 lines) or a print-styled
// HTML page made from the same lines (no script, no remote resource). Built in memory for the one
// response or the one file that asks for it; never logged, never stored, never in an error.
//
// It holds: the instance's address, Kept's version and revision, when it was made; the secret key,
// its version and every retired key; the auth secret; the backup's restic repository, its
// password and its storage credentials (S3 keys, or the SFTP key and the pinned host key), or
// that none is configured; and the restore steps, with the commands to read the inventory with
// restic alone (docs: "Read your inventory with restic alone") filled in.

/** The keys as the running server uses them (config/env.ts readKeyMaterial). */
export type KitKeys = {
  secretKey: string;
  authSecret: string;
  secretKeyVersion: number;
  /** `version:key` pairs as configured, or undefined. */
  retired: string | undefined;
  /** `environment`, or the secrets.json they were read from. */
  source: string;
};

/** The kit's keys from what readKeyMaterial() found. */
export function kitKeysOf(m: KeyMaterial): KitKeys {
  return {
    secretKey: m.KEPT_SECRET_KEY,
    authSecret: m.KEPT_AUTH_SECRET,
    secretKeyVersion: m.KEPT_SECRET_KEY_VERSION,
    retired: m.KEPT_SECRET_KEYS_RETIRED,
    source: m.source,
  };
}

/** The backup half, unsealed (backup/recovery-kit-source.ts). Every value is the operator's. */
export type KitBackup = {
  kind: BackupTargetKind;
  /** What logs show, e.g. "directory /mnt/nas/kept". */
  description: string;
  /** `RESTIC_REPOSITORY`: a path, `s3:…` or `sftp:…`. */
  repository: string;
  /** `RESTIC_PASSWORD`. */
  password: string;
  /** The storage credentials as the environment variables restic reads, e.g.
   * `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (S3). Never the password. */
  environment: readonly (readonly [name: string, value: string])[];
  /** SFTP: the private key and the server's pinned host key, as `known_hosts` wants it. */
  sftp: { privateKey: string; knownHostsLine: string } | null;
  /** The server's environment sets the target (D186). */
  lockedByEnvironment: boolean;
};

/** What the kit can say about backups. `unavailable`: one is configured, but this kit could not
 * read it (the CLI without the database owner's login, a database that didn't answer). */
export type KitBackupHalf =
  | { state: 'none' }
  | { state: 'unavailable'; reason: string }
  | { state: 'configured'; backup: KitBackup };

export type RecoveryKitInput = {
  generatedAt: Date;
  publicUrl: string | null;
  version: string;
  revision: string | null;
  keys: KitKeys;
  backup: KitBackupHalf;
};

/** Single-quoted for a POSIX shell: `'` becomes `'\''`. */
export const shellQuote = (value: string): string => `'${value.split("'").join("'\\''")}'`;

/** One kit line per entry; a block (a key file) keeps its own lines. */
function backupLines(half: KitBackupHalf): string[] {
  if (half.state === 'none') {
    return [
      'No backup configured.',
      'Nothing is copied off this server. Set a backup up in Admin → Backups, then download',
      'this kit again: it will hold the repository, its password and its credentials.',
    ];
  }
  if (half.state === 'unavailable') {
    return [
      `Not included: ${half.reason}`,
      'Download the kit again from Admin → Status, or run kept admin recovery-kit with the',
      "database owner's login (KEPT_OWNER_DATABASE_URL), to include it.",
    ];
  }
  const b = half.backup;
  const lines = [
    `Target: ${b.description}${b.lockedByEnvironment ? " (set by the server's environment)" : ''}`,
    `RESTIC_REPOSITORY=${b.repository}`,
    `RESTIC_PASSWORD=${b.password}`,
    ...b.environment.map(([name, value]) => `${name}=${value}`),
  ];
  if (b.sftp) {
    lines.push(
      '',
      'The SFTP private key (save it as kept-backup-key, readable by you only):',
      ...b.sftp.privateKey.trimEnd().split(/\r?\n/),
      '',
      "The SFTP server's pinned host key (save this line as kept-known-hosts):",
      b.sftp.knownHostsLine,
    );
  }
  return lines;
}

/** The commands from "Read your inventory with restic alone", with this backup filled in. */
function resticAloneLines(half: KitBackupHalf): string[] {
  const steps = [
    'Read your inventory with restic alone (any computer with restic, no Kept, no network for',
    'a directory copied onto it):',
  ];
  if (half.state !== 'configured') {
    return [
      ...steps,
      '  With a backup configured, this kit lists the commands with the repository filled in;',
      '  see "Read your inventory with restic alone" in Kept\'s documentation.',
    ];
  }
  const b = half.backup;
  const exports = [
    `export RESTIC_REPOSITORY=${shellQuote(b.repository)}`,
    `export RESTIC_PASSWORD=${shellQuote(b.password)}`,
    ...b.environment.map(([name, value]) => `export ${name}=${shellQuote(value)}`),
  ];
  // restic's SFTP backend runs ssh: the key and the pinned host key go in as ssh arguments
  // (docs/spikes/2026-10-06-step8-restic.md, "Host key pinning").
  const sftp = b.sftp
    ? ` -o sftp.args=${shellQuote('-i kept-backup-key -o IdentitiesOnly=yes -o UserKnownHostsFile=kept-known-hosts -o StrictHostKeyChecking=yes')}`
    : '';
  return [
    ...steps,
    ...exports.map((line) => `  ${line}`),
    ...(b.sftp ? ['  chmod 600 kept-backup-key'] : []),
    `  restic${sftp} snapshots`,
    '  (take the newest snapshot tagged nightly or manual; pre_upgrade ones hold no readable copy)',
    `  restic${sftp} restore <snapshot ID> --target ./kept-readable --include /backup/readable`,
    '  Then open kept-readable/backup/readable/index.html in a browser.',
  ];
}

function restoreLines(half: KitBackupHalf): string[] {
  return [
    'To bring Kept back on a new server ("Restore and the drill" in Kept\'s documentation):',
    '  1. Install Kept as the install guide says, but before its first start set',
    '     KEPT_SECRET_KEY and KEPT_AUTH_SECRET (and the version and retired keys, when listed)',
    '     to the values above. Without them, secret values and AI keys stay unreadable.',
    half.state === 'configured'
      ? '  2. Set the backup target and its password to the values above.'
      : '  2. Set the backup target and its password to the ones your backups were made with.',
    '  3. Create an empty database and run kept admin restore <snapshot> into it; it checks',
    '     every table by its data digest. Then swap it in as the guide says.',
  ];
}

/** The kit's lines, the text and the HTML page alike. */
export function recoveryKitLines(kit: RecoveryKitInput): string[] {
  const k = kit.keys;
  const showVersion = k.secretKeyVersion !== 1 || k.retired !== undefined;
  return [
    'KEPT RECOVERY KIT',
    '',
    'Keep this somewhere other than this server: a password manager, or printed. Anyone with it',
    'can read your backups and every secret value in them; without it, a restore brings back',
    'everything except secret values and AI keys.',
    '',
    `Instance: ${kit.publicUrl ?? '(no public address set)'}`,
    `Kept: ${kit.version}${kit.revision ? ` (revision ${kit.revision})` : ''}`,
    `Made: ${kit.generatedAt.toISOString()}`,
    '',
    '== Keys ==',
    `Read from: ${k.source === 'environment' ? "the server's environment" : k.source}`,
    `KEPT_SECRET_KEY=${k.secretKey}`,
    `KEPT_AUTH_SECRET=${k.authSecret}`,
    ...(showVersion ? [`KEPT_SECRET_KEY_VERSION=${k.secretKeyVersion}`] : []),
    ...(k.retired ? [`KEPT_SECRET_KEYS_RETIRED=${k.retired}`] : []),
    ...(k.retired ? ['(Retired keys open backups made before a rotation: keep them.)'] : []),
    '',
    '== Backup ==',
    ...backupLines(kit.backup),
    '',
    '== Restore ==',
    ...restoreLines(kit.backup),
    '',
    ...resticAloneLines(kit.backup),
    '',
    'A new kit is needed after the backup settings change or the key is rotated; Admin → Status',
    'says when.',
  ];
}

export function renderRecoveryKitText(kit: RecoveryKitInput): string {
  return `${recoveryKitLines(kit).join('\n')}\n`;
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** The printable page: the same lines, monospaced, in a self-contained document. */
export function renderRecoveryKitHtml(kit: RecoveryKitInput): string {
  const body = escapeHtml(recoveryKitLines(kit).join('\n'));
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<title>Kept recovery kit</title>',
    '<style>',
    'body{margin:2rem;color:#111;background:#fff;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace}',
    'pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}',
    '@page{margin:15mm}',
    '@media print{body{margin:0}}',
    '</style>',
    '</head>',
    '<body>',
    `<pre>${body}</pre>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function renderRecoveryKit(kit: RecoveryKitInput, format: RecoveryKitFormat): string {
  return format === 'html' ? renderRecoveryKitHtml(kit) : renderRecoveryKitText(kit);
}

export const RECOVERY_KIT_CONTENT_TYPE: Record<RecoveryKitFormat, string> = {
  text: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
};

/** `kept-recovery-kit-2026-10-06.txt`. */
export function recoveryKitFilename(at: Date, format: RecoveryKitFormat): string {
  return `kept-recovery-kit-${at.toISOString().slice(0, 10)}.${format === 'html' ? 'html' : 'txt'}`;
}
