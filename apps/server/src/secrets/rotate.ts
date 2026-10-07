import type pg from 'pg';
import {
  type Aad,
  CryptoError,
  type Keyring,
  type MasterKey,
  rewrap,
  type Sealed,
} from '../crypto/envelope.js';
import { VAPID_AAD, VAPID_KEY } from '../notify/vapid.js';

// Re-wrapping every ciphertext under a new master key (`kept admin rotate-key`, engineering spec
// §7.3, D182). Only each value's small data key is re-encrypted (envelope.ts rewrap()); the
// value's own ciphertext never changes, and nothing is ever decrypted to plaintext here.
//
// CIPHERTEXTS is the registry of every column that holds a sealed value. Step 2 has one, the
// secret store. Steps 3 and 4 add theirs (AI provider keys, notification channels, webhook
// secrets, mailbox credentials, the VAPID key, the restic password) by appending a
// `sealedColumn({...})`, naming the table, how a row's AAD is formed (the same `table|row_id|
// field_key` the writer sealed it with) and nothing else: the rotation, its batching, its
// resumability and its report come with it. A test (rotate.test.ts) fails when a public table
// has a jsonb `ciphertext` column or a `key_version` column the registry doesn't list.
//
// It runs as kept_owner (the operator's login), which the tables' `owner_all` policies let
// through, one transaction per batch of 500. A row already under the target version is skipped,
// so an interrupted run is finished by running it again (`--resume`).

/** One column of sealed values, and how to rebuild each row's AAD. */
export type SealedColumn = Readonly<{
  /** For reports: what the values are. */
  name: string;
  /** Schema-qualified, e.g. `public.secret_values`. */
  table: string;
  /** The AAD's table part, as the writer sealed it (usually the bare table name). */
  aadTable: string;
  /** The column the AAD's field part comes from, or a constant for single-field tables. */
  fieldKey: { column: string } | { constant: string };
  idColumn?: string;
  ciphertextColumn?: string;
  versionColumn?: string;
}>;

export function sealedColumn(c: SealedColumn): SealedColumn {
  return Object.freeze({
    idColumn: 'id',
    ciphertextColumn: 'ciphertext',
    versionColumn: 'key_version',
    ...c,
  });
}

/** Every sealed column Kept has. Append here; never remove one while rows can hold values. */
export const CIPHERTEXTS: readonly SealedColumn[] = Object.freeze([
  sealedColumn({
    name: 'secret field values',
    table: 'public.secret_values',
    aadTable: 'secret_values',
    fieldKey: { column: 'field_key' },
  }),
  // Step 3 (T6, migration 0039): AI provider keys, sealed with AAD `ai_providers|<id>|api_key`
  // (ai/db-keys.ts providerKeyAad).
  sealedColumn({
    name: 'AI provider keys',
    table: 'public.ai_providers',
    aadTable: 'ai_providers',
    fieldKey: { constant: 'api_key' },
    ciphertextColumn: 'key_ciphertext',
  }),
  // Step 4 (T7, migration 0054): a webhook channel's `{url, secret}`, sealed with AAD
  // `notification_channels|<id>|config` (step-4 plan T7; the sealer is T15's notify/webhook.ts).
  sealedColumn({
    name: 'webhook channel configs',
    table: 'public.notification_channels',
    aadTable: 'notification_channels',
    fieldKey: { constant: 'config' },
    ciphertextColumn: 'config_ciphertext',
  }),
  // Step 6 (T7, migration 0077): a location webhook's signing secret, sealed with AAD
  // `webhooks|<id>|secret` (T15 seals it).
  sealedColumn({
    name: 'location webhook secrets',
    table: 'public.webhooks',
    aadTable: 'webhooks',
    fieldKey: { constant: 'secret' },
    ciphertextColumn: 'secret_ciphertext',
  }),
  // Step 7 (T4, migration 0079): the key derived from an export's or a Kept import's passphrase
  // (D68, plan Q7), sealed with AAD `export_runs|<id>|secrets_key` and
  // `import_runs|<id>|secrets_key` (portability/passphrase.ts); cleared when the run ends.
  sealedColumn({
    name: 'export passphrase keys',
    table: 'public.export_runs',
    aadTable: 'export_runs',
    fieldKey: { constant: 'secrets_key' },
    ciphertextColumn: 'secrets_key_ciphertext',
  }),
  sealedColumn({
    name: 'import passphrase keys',
    table: 'public.import_runs',
    aadTable: 'import_runs',
    fieldKey: { constant: 'secrets_key' },
    ciphertextColumn: 'secrets_key_ciphertext',
  }),
]);

/**
 * A sealed value inside an instance_settings row's JSON (`value -> field`), which has no key
 * version column of its own: the version is the sealed value's own `kv`.
 */
export type SealedSetting = Readonly<{ name: string; key: string; field: string; aad: Aad }>;

/** The instance setting holding the backup configuration (step 8 T10), its secrets sealed. */
export const BACKUP_SETTINGS_KEY = 'backup';

/** Every sealed instance setting. Append here, as for CIPHERTEXTS. */
export const SEALED_SETTINGS: readonly SealedSetting[] = Object.freeze([
  // Step 4 (T15, Q11): the VAPID private key web push signs with (notify/vapid.ts).
  Object.freeze({
    name: 'the web push (VAPID) key',
    key: VAPID_KEY,
    field: 'privateKeySealed',
    aad: VAPID_AAD,
  }),
  // Step 8 (T4, T10): the backup settings' write-only secrets, in the `backup` row, each sealed
  // with AAD `instance_settings|backup|<field>` by T10's settings route.
  ...(['password', 's3SecretAccessKey', 'sftpPrivateKey'] as const).map((field) =>
    Object.freeze({
      name: `the backup setting's ${field}`,
      key: BACKUP_SETTINGS_KEY,
      field,
      aad: Object.freeze({
        table: 'instance_settings',
        rowId: BACKUP_SETTINGS_KEY,
        fieldKey: field,
      }),
    }),
  ),
]);

const IDENT = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

function cols(c: SealedColumn) {
  const names = {
    table: c.table,
    id: c.idColumn ?? 'id',
    ct: c.ciphertextColumn ?? 'ciphertext',
    kv: c.versionColumn ?? 'key_version',
    field: 'column' in c.fieldKey ? c.fieldKey.column : null,
  };
  for (const n of Object.values(names)) {
    if (n !== null && !IDENT.test(n)) throw new Error(`sealed column: bad identifier ${n}`);
  }
  return names;
}

export type RotationFailure = { id: string; reason: string };
export type ColumnReport = { name: string; rewrapped: number; failed: RotationFailure[] };
export type RotationReport = { version: number; columns: ColumnReport[] };

export type RotateOptions = {
  batchSize?: number;
  columns?: readonly SealedColumn[];
  /** Called after each committed batch. */
  onBatch?: (column: string, done: number) => void;
  /** The sealed instance settings to re-wrap too (default: every one). */
  settings?: readonly SealedSetting[];
};

/** The key version of each sealed setting that holds a value. */
async function settingVersions(
  client: pg.ClientBase,
  settings: readonly SealedSetting[],
): Promise<number[]> {
  const out: number[] = [];
  for (const s of settings) {
    const { rows } = await client.query<{ kv: number | null }>(
      `SELECT (value -> $2 ->> 'kv')::int AS kv FROM public.instance_settings WHERE key = $1`,
      [s.key, s.field],
    );
    const kv = rows[0]?.kv;
    if (typeof kv === 'number') out.push(kv);
  }
  return out;
}

/** The key versions the rows of every sealed column use, with their counts. */
export async function versionsInUse(
  client: pg.ClientBase,
  columns: readonly SealedColumn[] = CIPHERTEXTS,
  settings: readonly SealedSetting[] = SEALED_SETTINGS,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const kv of await settingVersions(client, settings)) out.set(kv, (out.get(kv) ?? 0) + 1);
  for (const c of columns) {
    const n = cols(c);
    const { rows } = await client.query<{ kv: number; n: number }>(
      // An erased value (ciphertext NULL, kept.clear_secret) needs no key.
      `SELECT ${n.kv} AS kv, count(*)::int AS n FROM ${n.table}
        WHERE ${n.ct} IS NOT NULL GROUP BY ${n.kv}`,
    );
    for (const r of rows) out.set(r.kv, (out.get(r.kv) ?? 0) + r.n);
  }
  return out;
}

/**
 * Re-wraps every row not yet under `target` so that it is: one transaction per batch, rows
 * locked, keyset-paged by id so a row that can't be re-wrapped (its version's key missing, or
 * tampered) is reported and passed, never retried forever. `keyring` must hold every version the
 * rows use; `target` is the new current key.
 */
export async function rotateCiphertexts(
  client: pg.ClientBase,
  keyring: Keyring,
  target: MasterKey,
  opts: RotateOptions = {},
): Promise<RotationReport> {
  const batch = opts.batchSize ?? 500;
  const report: RotationReport = { version: target.keyVersion, columns: [] };
  for (const c of opts.columns ?? CIPHERTEXTS) {
    const n = cols(c);
    const out: ColumnReport = { name: c.name, rewrapped: 0, failed: [] };
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      await client.query('BEGIN');
      try {
        const { rows } = await client.query<{ id: string; ct: Sealed; field: string }>(
          `SELECT ${n.id}::text AS id, ${n.ct} AS ct,
                  ${n.field ?? '$4::text'} AS field
             FROM ${n.table}
            WHERE ${n.kv} <> $1 AND ${n.id} > $2::uuid AND ${n.ct} IS NOT NULL
            ORDER BY ${n.id} LIMIT $3 FOR UPDATE`,
          n.field
            ? [target.keyVersion, after, batch]
            : [target.keyVersion, after, batch, (c.fieldKey as { constant: string }).constant],
        );
        for (const row of rows) {
          const aad: Aad = { table: c.aadTable, rowId: row.id, fieldKey: row.field };
          let next: Sealed;
          try {
            next = rewrap(row.ct, keyring, target, aad);
          } catch (err) {
            if (!(err instanceof CryptoError)) throw err;
            out.failed.push({ id: row.id, reason: err.code });
            continue;
          }
          await client.query(
            `UPDATE ${n.table} SET ${n.ct} = $2, ${n.kv} = $3 WHERE ${n.id} = $1`,
            [row.id, JSON.stringify(next), target.keyVersion],
          );
          out.rewrapped += 1;
        }
        await client.query('COMMIT');
        const last = rows.at(-1);
        opts.onBatch?.(c.name, out.rewrapped);
        if (!last || rows.length < batch) break;
        after = last.id;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
    report.columns.push(out);
  }
  for (const s of opts.settings ?? SEALED_SETTINGS) {
    const out: ColumnReport = { name: s.name, rewrapped: 0, failed: [] };
    await client.query('BEGIN');
    try {
      const { rows } = await client.query<{ sealed: Sealed | null }>(
        `SELECT value -> $2 AS sealed FROM public.instance_settings WHERE key = $1 FOR UPDATE`,
        [s.key, s.field],
      );
      const sealed = rows[0]?.sealed;
      if (sealed && sealed.kv !== target.keyVersion) {
        try {
          const next = rewrap(sealed, keyring, target, s.aad);
          await client.query(
            `UPDATE public.instance_settings SET value = jsonb_set(value, ARRAY[$2], $3::jsonb)
              WHERE key = $1`,
            [s.key, s.field, JSON.stringify(next)],
          );
          out.rewrapped += 1;
        } catch (err) {
          if (!(err instanceof CryptoError)) throw err;
          out.failed.push({ id: s.key, reason: err.code });
        }
      }
      await client.query('COMMIT');
      opts.onBatch?.(s.name, out.rewrapped);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    report.columns.push(out);
  }
  return report;
}
