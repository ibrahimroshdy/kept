import { createHash } from 'node:crypto';
import type pg from 'pg';

// Per-table data digests (step-8 plan T5, L78: a restore is verified by its data, not by row
// counts). For each table kept_owner owns, a SHA-256 over its rows in primary-key order:
//   digest = SHA-256( SHA-256(row₁ as text) ‖ SHA-256(row₂ as text) ‖ … )
// The database hashes each row (`sha256(convert_to(t::text, 'UTF8'))`), so only 32 bytes a row
// cross the wire, and the rows come in keyset pages, so memory stays flat however big a table is.
// A restore computes the same over the restored database (backup/restore.ts) and any table whose
// digest differs is a mismatch, even when its count is the same.
//
// What makes the two sides comparable:
// - the session settings that shape a row's text are fixed (digestSession): the time zone, the
//   date and interval styles, float digits, bytea output;
// - text-like key columns are ordered by the "C" collation, so a restore database created with
//   another default collation orders them the same (uuid and integer keys, nearly every table,
//   have no collation and keep their index order);
// - a table without a primary key is ordered by its rows' hashes.
// Run inside the backup's REPEATABLE READ snapshot, the digests describe exactly what pg_dump
// dumped.

const PAGE = 5000;

/** SET (or, in a transaction, SET LOCAL) the settings a row's text depends on. */
export async function digestSession(client: pg.ClientBase, local: boolean): Promise<void> {
  const set = local ? 'SET LOCAL' : 'SET';
  for (const statement of [
    `${set} TimeZone = 'UTC'`,
    `${set} DateStyle = 'ISO, YMD'`,
    `${set} IntervalStyle = 'postgres'`,
    `${set} extra_float_digits = 1`,
    `${set} bytea_output = 'hex'`,
  ]) {
    await client.query(statement);
  }
}

type KeyColumn = { quoted: string; type: string; collatable: boolean };

async function primaryKey(client: pg.ClientBase, ident: string): Promise<KeyColumn[]> {
  const { rows } = await client.query<KeyColumn>(
    `SELECT quote_ident(a.attname) AS quoted, format_type(a.atttypid, a.atttypmod) AS type,
            a.attcollation <> 0 AS collatable
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [ident],
  );
  return rows;
}

/** The digest of one table (`ident` is a quoted `schema.table`). */
export async function tableDigest(client: pg.ClientBase, ident: string): Promise<string> {
  const outer = createHash('sha256');
  const key = await primaryKey(client, ident);
  if (key.length === 0) {
    for (let offset = 0; ; offset += PAGE) {
      const { rows } = await client.query<{ h: Buffer }>(
        `SELECT sha256(convert_to(t::text, 'UTF8')) AS h FROM ${ident} t
          ORDER BY 1 LIMIT ${PAGE} OFFSET ${offset}`,
      );
      for (const r of rows) outer.update(r.h);
      if (rows.length < PAGE) break;
    }
    return outer.digest('hex');
  }
  const order = key.map((k) => (k.collatable ? `${k.quoted} COLLATE "C"` : k.quoted)).join(', ');
  const select = key.map((k, i) => `${k.quoted}::text AS k${i}`).join(', ');
  const after = `(${order}) > (${key
    .map((k, i) => `$${i + 1}::${k.type}${k.collatable ? ' COLLATE "C"' : ''}`)
    .join(', ')})`;
  let last: string[] | null = null;
  for (;;) {
    const { rows } = await client.query<Record<string, string> & { h: Buffer }>(
      `SELECT ${select}, sha256(convert_to(t::text, 'UTF8')) AS h FROM ${ident} t
        ${last ? `WHERE ${after}` : ''} ORDER BY ${order} LIMIT ${PAGE}`,
      last ?? [],
    );
    for (const r of rows) outer.update(r.h);
    if (rows.length < PAGE) break;
    const tail = rows[rows.length - 1] as Record<string, string>;
    last = key.map((_k, i) => tail[`k${i}`] as string);
  }
  return outer.digest('hex');
}

/** `schema.table` → digest, for each table given. */
export async function tableDigests(
  client: pg.ClientBase,
  tables: readonly { name: string; ident: string }[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of tables) out[t.name] = await tableDigest(client, t.ident);
  return out;
}

/** The tables whose digests differ (or are missing on one side). */
export function digestMismatches(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): string[] {
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...names].filter((n) => expected[n] !== actual[n]).sort();
}
