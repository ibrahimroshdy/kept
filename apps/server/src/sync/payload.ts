import { createHash } from 'node:crypto';
import {
  ErrorCode,
  idTimestamp,
  isV7,
  MIN_PAYLOAD_VERSION,
  type OpKind,
  type OpPayload,
  PAYLOAD_VERSION,
  PayloadVersionError,
  parseOpPayload,
  type QueueItem,
  SYNC_LIMITS,
  UPGRADERS,
  type UpgraderTable,
  upgradePayload,
} from '@kept/shared';
import { AppError } from '../http/errors.js';

// What `POST /api/v1/sync/ops` checks of an op before any handler runs (plan T14, Q2, Q3; D17,
// D148; engineering spec §2.3, §7.4): the batch's payload versions, the ledger's key and hash, the
// ops-only client-id window, and the payload itself.

const DAY_MS = 86_400_000;

/** The payload versions this server takes, and how it brings older ones up (D148). */
export type PayloadWindow = {
  /** The oldest version still upgraded on arrival; below it the batch is `client_outdated`. */
  min: number;
  upgraders: UpgraderTable;
};

/** The build's own window. Above `PAYLOAD_VERSION` is always `server_outdated`. */
export const PAYLOAD_WINDOW: PayloadWindow = Object.freeze({
  min: MIN_PAYLOAD_VERSION,
  upgraders: UPGRADERS,
});

/**
 * The whole batch's refusal (Q3), or null: any op below the window is 409 `client_outdated`
 * `{minPayloadVersion}` ("Update Kept to finish syncing"), any above it 409 `server_outdated`
 * ("Kept on the server is older than this app; ask your admin"). Nothing of a refused batch is
 * applied, and the phone keeps its queue. An old op wins over a new one in the same batch: the
 * phone can fix that by updating.
 */
export function batchRefusal(
  ops: readonly Pick<QueueItem, 'payloadVersion'>[],
  window: PayloadWindow = PAYLOAD_WINDOW,
): AppError | null {
  if (ops.some((o) => o.payloadVersion < window.min)) {
    return new AppError(ErrorCode.client_outdated, 409, undefined, {
      minPayloadVersion: window.min,
    });
  }
  if (ops.some((o) => o.payloadVersion > PAYLOAD_VERSION)) {
    return new AppError(ErrorCode.server_outdated, 409, undefined, {
      payloadVersion: PAYLOAD_VERSION,
    });
  }
  return null;
}

/** The op's payload at this build's version, validated with its schema; null when it isn't one. */
export function parsedPayload<K extends OpKind>(
  op: K,
  payloadVersion: number,
  payload: unknown,
  window: PayloadWindow = PAYLOAD_WINDOW,
): OpPayload<K> | null {
  let current: unknown;
  try {
    current = upgradePayload(op, payloadVersion, payload, window.upgraders);
  } catch (err) {
    // A version inside the window with no upgrade step is this server's bug, never the phone's:
    // it is answered as the op being unreadable, and the step is added in the next release.
    if (err instanceof PayloadVersionError) return null;
    throw err;
  }
  const parsed = parseOpPayload(op, current);
  return parsed.success ? (parsed.data as OpPayload<K>) : null;
}

/** The ledger's key format (sync_ops_key_chk, 0035). A key outside it is answered `invalid` and
 * not recorded; the phone's keys (`cap:<uuid>`, `seen:<uuid>`, `claim:<code>`, …) all fit. */
export const LEDGER_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;

/**
 * A client-made UUIDv7 inside the ops-only window (Q2): up to 90 days old and 1 day ahead. The
 * online routes keep ±7 days (§7.7); a phone offline for weeks still syncs.
 */
export function inOpsWindow(id: string, now: number = Date.now()): boolean {
  if (!isV7(id)) return false;
  const at = idTimestamp(id);
  return (
    at >= now - SYNC_LIMITS.clientIdPastDays * DAY_MS &&
    at <= now + SYNC_LIMITS.clientIdFutureDays * DAY_MS
  );
}

/** The ids a payload makes rows with, which the services then take unchecked (`via: 'op'`). */
export function madeIds(op: OpKind, payload: unknown): string[] {
  const p = payload as Record<string, unknown>;
  switch (op) {
    case 'create_thing':
    case 'log_reading':
    case 'create_area':
    case 'box_check':
      return [p.id as string];
    case 'claim_label': {
      const target = p.target as { newContainer?: { id: string } };
      return target.newContainer ? [target.newContainer.id] : [];
    }
    default:
      return [];
  }
}

/** JSON with object keys sorted, so the same op hashes the same whatever order it was built in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The op's `request_hash` in the ledger: what it asks for, as sent. The client version is left
 * out (an app update between two sends of one op is still the same op), and `dependsOn` counts as
 * a set. The phone re-sends an unanswered op unchanged (T24: a `sent` op is never upgraded), so a
 * replay hashes the same; a different body under the same key is `idempotency_mismatch`.
 */
export function requestHash(item: QueueItem): string {
  return createHash('sha256')
    .update(
      canonical({
        op: item.op,
        payloadVersion: item.payloadVersion,
        clientId: item.clientId.toLowerCase(),
        locationId: item.locationId.toLowerCase(),
        takenAt: item.takenAt,
        dependsOn: [...(item.dependsOn ?? [])].sort(),
        payload: item.payload,
      }),
    )
    .digest('hex');
}
