import pg from 'pg';
import type { TestDb } from './db.js';

async function asOwner<T>(db: TestDb, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: db.urls.owner });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Leaves a table behind naming the file that made it, as a careless test would. */
export function leaveMarker(db: TestDb, file: string): Promise<void> {
  return asOwner(db, async (client) => {
    await client.query('CREATE TABLE IF NOT EXISTS public.harness_leftover (file text)');
    await client.query('INSERT INTO public.harness_leftover VALUES ($1)', [file]);
  });
}

/** The files whose markers are in this database; `[]` only on a fresh clone. The table
 * itself counts, so a leftover emptied by reset() is still seen. */
export function markerLeftBy(db: TestDb): Promise<string[]> {
  return asOwner(db, async (client) => {
    const reg = await client.query(`SELECT to_regclass('public.harness_leftover') AS reg`);
    if (!reg.rows[0].reg) return [];
    const { rows } = await client.query<{ file: string }>(
      'SELECT file FROM public.harness_leftover ORDER BY file',
    );
    return rows.length ? rows.map((r) => r.file) : ['(empty harness_leftover table)'];
  });
}
