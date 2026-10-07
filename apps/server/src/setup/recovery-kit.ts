import type pg from 'pg';
import { AppError } from '../http/errors.js';

// The recovery-kit acknowledgement (D193, refining D66): the instance admin confirms they have a
// copy of the keys off the server. It no longer blocks finishing setup; it is required at the
// first of adding a secret value, adding an AI key, or configuring backups (later steps call
// requireRecoveryKitAck() there), and until then the status page asks for it.

/** The instance_settings key: a JSON ISO timestamp, written once. */
export const RECOVERY_KIT_KEY = 'recovery_kit_acknowledged_at';

/** When the kit was acknowledged, or null. Read as kept_system (or kept_owner): the caller of the
 * gate is usually not an instance admin (anyone adding a secret value). */
export async function recoveryKitAcknowledgedAt(
  client: pg.ClientBase | pg.Pool,
): Promise<Date | null> {
  const { rows } = await client.query<{ value: unknown }>(
    'SELECT value FROM public.instance_settings WHERE key = $1',
    [RECOVERY_KIT_KEY],
  );
  const value = rows[0]?.value;
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The gate: 409 `recovery_kit_required` until an instance admin has acknowledged the kit. */
export async function requireRecoveryKitAck(systemPool: pg.ClientBase | pg.Pool): Promise<void> {
  if (await recoveryKitAcknowledgedAt(systemPool)) return;
  throw new AppError(
    'recovery_kit_required',
    409,
    'An instance admin must save the recovery kit (kept admin recovery-kit) and confirm it first.',
  );
}

/** Records the acknowledgement, keeping the first one. `client` is an instance admin's kept_app
 * transaction (instance_settings is theirs under 0006's app_admin policy). */
export async function acknowledgeRecoveryKit(client: pg.ClientBase): Promise<{
  acknowledgedAt: Date;
  first: boolean;
}> {
  const { rows } = await client.query<{ value: string }>(
    `INSERT INTO public.instance_settings (key, value) VALUES ($1, to_jsonb(now()))
     ON CONFLICT (key) DO NOTHING RETURNING value #>> '{}' AS value`,
    [RECOVERY_KIT_KEY],
  );
  if (rows[0]) return { acknowledgedAt: new Date(rows[0].value), first: true };
  const at = await recoveryKitAcknowledgedAt(client);
  return { acknowledgedAt: at ?? new Date(), first: false };
}

// The kit's download and staleness (step-8 T9; screens §10: "when backups are configured, the
// status page asks again"). Two more instance_settings keys, each a JSON ISO timestamp:
// - `recovery_kit_downloaded_at`: the last download (web or `kept admin recovery-kit` with the
//   database), which also counts as the acknowledgement when none exists;
// - `recovery_kit_stale_since`: when something the kit holds last changed. Set by
//   markRecoveryKitStale(): `kept admin rotate-key` (a new key, D182), and the backup settings'
//   PUT (T10). The kit is stale while that is later than the last download.

/** The instance_settings key holding the last download's time. */
export const RECOVERY_KIT_DOWNLOADED_KEY = 'recovery_kit_downloaded_at';
/** The instance_settings key holding when the kit's content last changed. */
export const RECOVERY_KIT_STALE_KEY = 'recovery_kit_stale_since';

/** What the status page and `GET /api/v1/admin/recovery-kit` say (@kept/shared RecoveryKitState). */
export type RecoveryKitStatus = {
  acknowledgedAt: string | null;
  downloadedAt: string | null;
  /** Downloaded, and something the kit holds changed since. */
  stale: boolean;
};

const asDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

/** The kit's state, read by an instance admin's kept_app transaction, kept_system or kept_owner. */
export async function recoveryKitStatus(
  client: pg.ClientBase | pg.Pool,
): Promise<RecoveryKitStatus> {
  const { rows } = await client.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM public.instance_settings WHERE key = ANY($1::text[])',
    [[RECOVERY_KIT_KEY, RECOVERY_KIT_DOWNLOADED_KEY, RECOVERY_KIT_STALE_KEY]],
  );
  const of = (key: string) => asDate(rows.find((r) => r.key === key)?.value);
  const acknowledgedAt = of(RECOVERY_KIT_KEY);
  const downloadedAt = of(RECOVERY_KIT_DOWNLOADED_KEY);
  const staleSince = of(RECOVERY_KIT_STALE_KEY);
  return {
    acknowledgedAt: acknowledgedAt?.toISOString() ?? null,
    downloadedAt: downloadedAt?.toISOString() ?? null,
    stale: downloadedAt !== null && staleSince !== null && staleSince > downloadedAt,
  };
}

/** Upserts one timestamp setting at the transaction's `now()` (touch_row keeps the row's version). */
async function stamp(client: pg.ClientBase, key: string): Promise<void> {
  await client.query(
    `INSERT INTO public.instance_settings (key, value) VALUES ($1, to_jsonb(now()))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key],
  );
}

/**
 * Records a download: its time, and the acknowledgement when none exists (D193: a downloaded
 * kit is a kept one). `client` is an instance admin's kept_app transaction, or kept_owner (the
 * CLI). Returns whether this was also the first acknowledgement.
 */
export async function recordRecoveryKitDownload(
  client: pg.ClientBase,
): Promise<{ firstAcknowledgement: boolean }> {
  await stamp(client, RECOVERY_KIT_DOWNLOADED_KEY);
  const { first } = await acknowledgeRecoveryKit(client);
  return { firstAcknowledgement: first };
}

/**
 * Something the kit holds changed (a rotated key, new backup settings): a kit downloaded before
 * now is stale, and the status page asks for a new one. Call it in the transaction that makes
 * the change, as an instance admin (kept_app), kept_system or kept_owner.
 */
export async function markRecoveryKitStale(client: pg.ClientBase): Promise<void> {
  await stamp(client, RECOVERY_KIT_STALE_KEY);
}
