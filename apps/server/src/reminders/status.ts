import type pg from 'pg';

// The reminder scan's own record (plan T7, T14; D166, §3.4): `instance_settings.reminder_scan`,
// written by the scan as kept_system, read by the admin status page (kept_app as an instance
// admin) and by `check-admin-alerts`, which raises `reminders_not_scanned` when no pass has
// finished for 2 hours and resolves it after the next good one.

export const REMINDER_SCAN_KEY = 'reminder_scan';

/** No finished pass for this long raises `reminders_not_scanned` (§3.4). */
export const NOT_SCANNED_HOURS = 2;

export type ScanStatus = {
  /** When the last pass started. */
  lastRunAt: string | null;
  /** When the last pass that finished did. */
  lastOkAt: string | null;
  /** New occurrences the last good pass wrote. */
  occurrences: number;
  /** How long the last good pass took. */
  durationMs: number;
  /** The first pass this instance ever started: the clock for an instance that never finished
   * one. Not shown on the status page. */
  firstRunAt: string | null;
};

const EMPTY: ScanStatus = {
  lastRunAt: null,
  lastOkAt: null,
  occurrences: 0,
  durationMs: 0,
  firstRunAt: null,
};

const text = (v: unknown) => (typeof v === 'string' ? v : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The stored record, or null before the first pass. */
export async function readScanStatus(client: pg.ClientBase): Promise<ScanStatus | null> {
  const { rows } = await client.query<{ value: Record<string, unknown> }>(
    'SELECT value FROM public.instance_settings WHERE key = $1',
    [REMINDER_SCAN_KEY],
  );
  const v = rows[0]?.value;
  if (!v || typeof v !== 'object') return null;
  return {
    lastRunAt: text(v.lastRunAt),
    lastOkAt: text(v.lastOkAt),
    occurrences: count(v.occurrences),
    durationMs: count(v.durationMs),
    firstRunAt: text(v.firstRunAt) ?? text(v.lastRunAt),
  };
}

/** Merges `patch` into the record (kept_system). */
export async function writeScanStatus(
  client: pg.ClientBase,
  patch: Partial<ScanStatus>,
): Promise<ScanStatus> {
  const before = (await readScanStatus(client)) ?? EMPTY;
  const next: ScanStatus = { ...before, ...patch };
  next.firstRunAt ??= next.lastRunAt;
  await client.query(
    `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [REMINDER_SCAN_KEY, JSON.stringify(next)],
  );
  return next;
}

/**
 * Whether the scan has gone quiet: no pass finished in the last 2 hours, counting from the first
 * pass for an instance that never finished one. Before any pass at all (a worker just started),
 * nothing is wrong yet.
 */
export function scanOverdue(status: ScanStatus | null, now: Date): boolean {
  const since = status?.lastOkAt ?? status?.firstRunAt ?? null;
  if (!since) return false;
  return now.getTime() - new Date(since).getTime() > NOT_SCANNED_HOURS * 3_600_000;
}
