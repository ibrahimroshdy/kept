import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// The snapshot cursor (plan T12; engineering spec §7.4; plan Q1). Opaque to the phone:
//
//   base64url(JSON CursorState) + "." + base64url(HMAC-SHA256(that first part))
//
// signed with a key derived from KEPT_AUTH_SECRET by HKDF (salt `kept-sync`, info
// `sync-cursor`), the sibling of the signed-file-URL key (storage/signed-url.ts). A phone can't
// forge a watermark to read what row-level security would show it anyway: this is defence in
// depth, not the access check. A cursor that doesn't verify is a 400 `validation`; so is one
// signed before KEPT_AUTH_SECRET changed, and the phone starts again from a full pass.
//
// The state, and why it isn't the plan's `{since, passXmin, after, locs}` word for word:
// - `w` holds one watermark per location, from the last complete pass. A location the person
//   joined since has none, so its pass reads it in full ('0') instead of from a watermark that
//   predates their access (with one `since` for all, its older rows would never arrive).
// - `p` is the pass in progress: its horizon `x` (pg_snapshot_xmin at the pass's first page),
//   the locations it reads with the watermark each started from (`l`, fixed for the pass), where
//   the last page stopped (`a`), and the truncation cut (`c`) when the person has more things
//   than the phone keeps (Q30).
// - `revokedLocationIds` is every location in `w` or `p.l` that isn't visible any more.

/** The tables a pass reads, in this order. */
export const SNAPSHOT_TABLES = ['places', 'things', 'codes', 'legacyCodes', 'tombstones'] as const;
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

/** 'From the start': a full read of the location, trash and tombstones left out. */
export const FROM_START = '0';

/** Watermarks by location id: a pg xid8 as decimal text, or FROM_START. */
export type Watermarks = Record<string, string>;

/** Where a pass stopped: the table, the location, and the last row's key in that table's order. */
export type After = { t: SnapshotTable; l: string; k: string[] };

export type Pass = {
  /** pg_snapshot_xmin(pg_current_snapshot()) at the pass's first page: the next watermark. */
  x: string;
  /** The locations this pass reads, with the watermark each reads from. */
  l: Watermarks;
  /** Where the last page stopped; null before the first row. */
  a: After | null;
  /** Past SYNC_LIMITS.snapshotThings: live things older than `[lastSeenAt, id]` are left out. */
  c?: [string, string];
};

export type CursorState = { v: 1; w: Watermarks; p: Pass | null };

/** The state of a phone that has never synced. */
export const FIRST_SYNC: CursorState = Object.freeze({ v: 1, w: {}, p: null }) as CursorState;

const Xid = z.string().regex(/^\d{1,20}$/);
const Uuid = z.uuid();
const Marks = z.record(Uuid, Xid).refine((m) => Object.keys(m).length <= 10_000);

const StateSchema = z.strictObject({
  v: z.literal(1),
  w: Marks,
  p: z
    .strictObject({
      x: Xid,
      l: Marks,
      a: z
        .strictObject({
          t: z.enum(SNAPSHOT_TABLES),
          l: Uuid,
          k: z.array(z.string().max(200)).min(1).max(3),
        })
        .nullable(),
      c: z.tuple([z.string().max(64), Uuid]).optional(),
    })
    .nullable(),
});

const PART = /^[A-Za-z0-9_-]+$/;

/** HKDF-SHA256(authSecret, salt `kept-sync`, info `sync-cursor`), 32 bytes. */
export function syncCursorKey(authSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', authSecret, 'kept-sync', 'sync-cursor', 32));
}

const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest();

export function signCursor(key: Buffer, state: CursorState): string {
  const encoded = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${encoded}.${mac(key, encoded).toString('base64url')}`;
}

/** The state a cursor carries, or null when it is malformed or not signed with `key`. */
export function verifyCursor(key: Buffer, token: string): CursorState | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  if (!PART.test(encoded) || !PART.test(signature)) return null;
  const given = Buffer.from(signature, 'base64url');
  const wanted = mac(key, encoded);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = StateSchema.safeParse(raw);
  return parsed.success ? (parsed.data as CursorState) : null;
}
