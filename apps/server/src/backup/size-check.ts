// The size check (step-8 plan T5, L79, Q25): a dump far smaller than the last good one is
// suspicious (a bug that emptied a table, a dump of the wrong database). The snapshot is still
// taken (it may be right), but the run is a `warning` with `backup_suspicious_size`, its
// retention is skipped, and the alert says why, so a bad dump can never push good snapshots out.
//
// Suspicious, against the last good run (backup/runs.ts GOOD_RUN_SQL):
// - the dump under half the size, or
// - any of things, places, attachments or files with under half its rows.
// Small figures are noise (deleting 3 of 5 things is a household's right): the dump is compared
// only from 256 KiB, a table only from 10 rows. A real shrink is accepted by one run with
// `kept admin backup --accept-size`, which becomes the new baseline.

export const WATCHED_TABLES = [
  'public.things',
  'public.places',
  'public.attachments',
  'public.files',
] as const;

const MIN_DUMP_BYTES = 256 * 1024;
const MIN_ROWS = 10;

export type SizeFigures = { dbBytes: number; rows: Readonly<Record<string, number>> };

export type SizeCheck = {
  ok: boolean;
  /** What shrank, e.g. `dump 1200000 → 400000`, `public.things 120 → 3`: figures only. */
  reasons: string[];
};

/** The watched tables' counts, for `backup_runs.detail.rows`. */
export function watchedRows(tables: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of WATCHED_TABLES) if (typeof tables[t] === 'number') out[t] = tables[t];
  return out;
}

export function sizeCheck(current: SizeFigures, previous: SizeFigures | null): SizeCheck {
  if (!previous) return { ok: true, reasons: [] };
  const reasons: string[] = [];
  if (previous.dbBytes >= MIN_DUMP_BYTES && current.dbBytes < previous.dbBytes / 2) {
    reasons.push(`dump ${previous.dbBytes} → ${current.dbBytes}`);
  }
  for (const t of WATCHED_TABLES) {
    const before = previous.rows[t];
    const now = current.rows[t] ?? 0;
    if (typeof before === 'number' && before >= MIN_ROWS && now < before / 2) {
      reasons.push(`${t} ${before} → ${now}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
