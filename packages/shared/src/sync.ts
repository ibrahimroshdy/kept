/**
 * The offline sync contract (engineering spec §2.2, §2.3, §7.4; D17, D35, D112, D148, D172,
 * D175; plan Q1–Q3, Q30). The phone's queue items and the server's `POST /api/v1/sync/ops`
 * parse with these schemas, and the snapshot rows are typed here once for both sides.
 *
 * Payloads are versioned (D148). The server takes `MIN_PAYLOAD_VERSION`…`PAYLOAD_VERSION`,
 * upgrades older payloads with `upgradePayload`, then validates with the op's schema. Below the
 * window the whole batch is 409 `client_outdated`; above it (a server rollback) 409
 * `server_outdated`. Nothing in a refused batch is applied, and the phone keeps its queue.
 *
 * Queue ops skip `row_version` and follow D35 ("latest wins, visibly"), except readings and
 * label claims, which the server orders itself (D112).
 */

import { z } from 'zod';
import { CAPTURE_MODES } from './capture.js';
import type { LoanDirection } from './household.js';
import { ATTACHMENT_ROLES, type Lifecycle } from './inventory.js';
import type { ModuleId } from './modules.js';
import type { Role } from './roles.js';
import { SHORT_CODE } from './short-code.js';
import { AMOUNT_STRING } from './type-fields.js';

/** The payload schema this build writes and reads (D148). */
export const PAYLOAD_VERSION = 1;
/** The oldest payload this build still upgrades on arrival (D148: current and previous). */
export const MIN_PAYLOAD_VERSION = 1;

export const OP_KINDS = [
  'create_thing',
  'move',
  'log_reading',
  'claim_label',
  'mark_seen',
  'not_here',
  'create_area',
  'box_check',
] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** Each op's answer (§2.3, §7.4). */
export const OUTCOMES = ['applied', 'needs_review', 'dropped'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Why an op was dropped. A drop is always visible on the phone, never silent (D35). */
export const DROP_REASONS = [
  'target_trashed',
  'target_missing',
  'not_permitted',
  'parent_dropped',
  'idempotency_mismatch',
  'invalid',
  'location_revoked',
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** Limits (§2.2, §7.4, plan T12, T14, Q2, Q30). */
export const SYNC_LIMITS = Object.freeze({
  /** Ops per `POST /sync/ops`. */
  opsPerBatch: 50,
  /** Things per `move` op. */
  moveThings: 200,
  /** Snapshot page size: default and maximum. */
  snapshotPageDefault: 1000,
  snapshotPageMax: 2000,
  /** Things per user in the snapshot; past it the response says `truncated` (Q30). */
  snapshotThings: 20_000,
  /** The ops-only client-id window (Q2); online routes keep ±7 days (§7.7). */
  clientIdPastDays: 90,
  clientIdFutureDays: 1,
});

/** A registry key (place kinds, types): the pattern the server's `KIND_KEY` and CHECKs use. */
export const REGISTRY_KEY = /^[a-z][a-z0-9_]{0,39}$/;

const uuid = z.uuid();
const name = z.string().trim().min(1).max(200);
/** A decimal string (D183), at most 12 integer digits and 4 decimals, the same as amounts. */
const decimal = z.string().regex(AMOUNT_STRING);
const positive = decimal.refine((s) => Number(s) > 0, 'must be more than 0');
const isoDateTime = z.iso.datetime({ offset: true });
const shortCode = z.string().regex(SHORT_CODE);

const placeTarget = z.strictObject({ placeId: uuid });
const containerTarget = z.strictObject({ containerId: uuid });

export const CreateThingPayload = z.strictObject({
  id: uuid,
  target: z.union([placeTarget, containerTarget, z.strictObject({ unplaced: z.literal(true) })]),
  mode: z.enum(CAPTURE_MODES),
  name: name.optional(),
  typeId: uuid.optional(),
  quantity: positive.optional(),
  batchId: uuid,
  files: z
    .array(
      z.strictObject({
        fileId: uuid,
        role: z.enum(ATTACHMENT_ROLES),
        displayFileId: uuid.optional(),
        /**
         * The original's SHA-256 (the `X-Kept-Sha256` it was uploaded with). The upload of bytes
         * already in the location answers the existing file (`deduplicatedFrom`, D177) and makes
         * no file with `fileId`; the server then finds that file by this hash (plan T14).
         */
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      }),
    )
    .max(20),
  /** "+ photo to this thing" (D175): the capture adds its files to an existing draft. */
  attachToThingId: uuid.optional(),
  /**
   * RECEIPT mode's "+ photo" (screens §8 "Receipt pages"): this capture's files are further
   * pages of the receipt captured with that capture `id`, not a new receipt (plan Q13).
   */
  pageOf: uuid.optional(),
  /** RECEIPT and READING modes' "Note (optional)": text kept with the capture, never a name. */
  note: z.string().trim().min(1).max(500).optional(),
  meterId: uuid.optional(),
  barcode: z.string().trim().min(1).max(64).optional(),
  templateId: uuid.optional(),
  /** A blank label scanned during capture (D43); the server claims it (D112). */
  claimCode: shortCode.optional(),
});

export const MovePayload = z.strictObject({
  thingIds: z.array(uuid).min(1).max(SYNC_LIMITS.moveThings),
  to: z.union([placeTarget, containerTarget]),
  /** Part of a quantity row (D10); omitted moves the whole row. */
  quantity: positive.optional(),
});

export const LogReadingPayload = z.strictObject({
  id: uuid,
  meterId: uuid,
  value: decimal,
  /** When it was read on the device; the server clamps it to the receipt time (D112). */
  takenAt: isoDateTime,
  note: z.string().trim().max(500).optional(),
  proofFileId: uuid.optional(),
  /**
   * The proof's SHA-256 (its upload's `X-Kept-Sha256`), as a capture file carries it: bytes
   * already in the location answer the existing file (`deduplicatedFrom`, D177) and make no file
   * with `proofFileId`, so the server finds the proof by this hash.
   */
  proofSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const ClaimLabelPayload = z.strictObject({
  code: shortCode,
  target: z.union([
    z.strictObject({ thingId: uuid }),
    z.strictObject({ placeId: uuid }),
    z.strictObject({
      /** A new box made for the label, in a place or inside another container (the claim
       * route's `newContainer`, labels/claim.ts). */
      newContainer: z.union([
        z.strictObject({ id: uuid, name, typeId: uuid.optional(), placeId: uuid }),
        z.strictObject({ id: uuid, name, typeId: uuid.optional(), containerId: uuid }),
      ]),
    }),
  ]),
});

export const MarkSeenPayload = z.strictObject({ thingId: uuid });
export const NotHerePayload = z.strictObject({ thingId: uuid });

export const CreateAreaPayload = z.strictObject({
  id: uuid,
  parentId: uuid.nullable(),
  name,
  kindKey: z.string().regex(REGISTRY_KEY),
});

export const BoxCheckPayload = z.strictObject({
  id: uuid,
  containerId: uuid,
  lines: z
    .array(z.strictObject({ thingId: uuid, expectedQty: decimal, foundQty: decimal }))
    .max(500),
  foundElsewhereIds: z.array(uuid).max(SYNC_LIMITS.moveThings).default([]),
});

/** The v1 payload schema per op. */
export const OP_SCHEMAS = Object.freeze({
  create_thing: CreateThingPayload,
  move: MovePayload,
  log_reading: LogReadingPayload,
  claim_label: ClaimLabelPayload,
  mark_seen: MarkSeenPayload,
  not_here: NotHerePayload,
  create_area: CreateAreaPayload,
  box_check: BoxCheckPayload,
} satisfies Record<OpKind, z.ZodType>);

export type OpPayload<K extends OpKind> = z.output<(typeof OP_SCHEMAS)[K]>;

/** Validates a payload that is already at `PAYLOAD_VERSION`. */
export function parseOpPayload<K extends OpKind>(op: K, payload: unknown) {
  return (OP_SCHEMAS[op] as (typeof OP_SCHEMAS)[K]).safeParse(payload);
}

/**
 * One queued op (§2.3, camelCased for the API). `payload` stays `unknown` here: it is validated
 * with the op's schema only after `upgradePayload`. `dependsOn` lists the idempotency keys of
 * earlier ops this one needs (a thing created in an area created offline); if any was dropped,
 * this one is dropped as `parent_dropped`.
 */
export const QueueItemSchema = z.strictObject({
  clientVersion: z.string().min(1).max(40),
  payloadVersion: z.number().int().min(0).max(1000),
  clientId: uuid,
  idempotencyKey: z.string().min(1).max(200),
  op: z.enum(OP_KINDS),
  takenAt: isoDateTime,
  locationId: uuid,
  dependsOn: z.array(z.string().min(1).max(200)).max(SYNC_LIMITS.opsPerBatch).optional(),
  payload: z.unknown(),
});
export type QueueItem = z.output<typeof QueueItemSchema>;

export const SyncOpsRequestSchema = z.strictObject({
  clientVersion: z.string().min(1).max(40),
  ops: z.array(QueueItemSchema).min(1).max(SYNC_LIMITS.opsPerBatch),
});
export type SyncOpsRequest = z.output<typeof SyncOpsRequestSchema>;

/**
 * One op's answer in `POST /sync/ops` (plan T14). `reason` when needs_review: `already_claimed`
 * (claim_label, or create_thing's `claimCode`), or the reading check's `lower_than_previous`,
 * `higher_than_next`, `implausible_jump`. `notice` names what changed under the op: "<name> was
 * <action> by <by>" (the place a move was going to, the thing it moved; D35).
 */
export type SyncOpResult = {
  clientId: string;
  idempotencyKey: string;
  outcome: Outcome;
  /** A `DropReason` when dropped; the review reason (e.g. `lower_than_previous`) otherwise. */
  reason?: DropReason | string;
  entity?: { type: string; id: string; shortCode?: string | null };
  /** "The drill was trashed by Alfred" (D35). */
  notice?: { name: string; by: { displayName: string }; action: 'trashed' | 'moved' | 'removed' };
  inboxItemId?: string;
};
/**
 * The answers, in the order the ops were sent. An op the server could not answer (an internal
 * error: not a domain outcome) stops the batch there: `results` holds the answers before it, with
 * status 200, and the phone sends the rest again with the same keys (plan T14, T24).
 */
export type SyncOpsResponse = { results: SyncOpResult[] };

export type PayloadVersionStatus = 'ok' | 'client_outdated' | 'server_outdated';

/** Where a payload version falls against this build's window (Q3). */
export function payloadVersionStatus(version: number): PayloadVersionStatus {
  if (version < MIN_PAYLOAD_VERSION) return 'client_outdated';
  if (version > PAYLOAD_VERSION) return 'server_outdated';
  return 'ok';
}

/** Upgrades one op's payload from version `n` to `n + 1`. */
export type PayloadUpgrader = (payload: unknown) => unknown;
/** Upgraders keyed by op, then by the version they upgrade *from*. */
export type UpgraderTable = Readonly<
  Partial<Record<OpKind, Readonly<Record<number, PayloadUpgrader>>>>
>;

/** v1 is the first payload version, so there is nothing to upgrade yet. */
export const UPGRADERS: UpgraderTable = Object.freeze({});

export class PayloadVersionError extends Error {
  constructor(
    readonly op: OpKind,
    readonly version: number,
  ) {
    super(`no upgrade path for ${op} payload v${version} to v${PAYLOAD_VERSION}`);
    this.name = 'PayloadVersionError';
  }
}

/**
 * Runs the upgraders from `version` up to `PAYLOAD_VERSION`, one step at a time. A current
 * payload is returned as is. The window check (`payloadVersionStatus`) comes first, on the
 * whole batch; this throws `PayloadVersionError` for a missing step or a version ahead of this
 * build, which the server treats as a bug, not as a client error.
 */
export function upgradePayload(
  op: OpKind,
  version: number,
  payload: unknown,
  upgraders: UpgraderTable = UPGRADERS,
): unknown {
  if (!Number.isInteger(version) || version > PAYLOAD_VERSION) {
    throw new PayloadVersionError(op, version);
  }
  let out = payload;
  for (let v = version; v < PAYLOAD_VERSION; v++) {
    const step = upgraders[op]?.[v];
    if (!step) throw new PayloadVersionError(op, version);
    out = step(out);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The snapshot (plan T12: `GET /api/v1/sync/snapshot`). No secrets, money, documents or contact
// details, ever (D36, D159).

export type SnapLocation = {
  id: string;
  name: string;
  kind: string;
  timezone: string;
  languages: string[];
  role: Role;
  effectiveModules: ModuleId[];
  unplacedPlaceId: string;
  latitude?: number;
  longitude?: number;
  suggestRadiusM: number;
};

export type SnapType = {
  id: string;
  builtinKey: string | null;
  name: string;
  icon: string | null;
  isContainer: boolean;
};

export type SnapPlace = {
  id: string;
  locationId: string;
  parentId: string | null;
  name: string;
  kindKey: string;
  icon: string | null;
  isUnplaced: boolean;
  sort: number;
  deleted: boolean;
};

/**
 * A meter on a thing, as READING needs it offline (plan T12, T13): which one to read, and how to
 * name it (`label`, else its kind: "Odometer", "Hours"). No readings, no offset: those stay
 * online.
 */
export type SnapMeter = {
  id: string;
  kind: string;
  unit: string;
  label: string | null;
  /**
   * Step 5 (Q18): the latest accepted reading, offset-corrected, so offline "Log a reading" shows
   * the last value. Optional: an older snapshot row still parses. Not money, not secret.
   */
  latest?: { value: string; takenAt: string };
};

export type SnapThing = {
  id: string;
  locationId: string;
  /** Null until the server allocates one at sync ("ID pending", D112). */
  shortCode: string | null;
  /** Null only for a draft. */
  name: string | null;
  /** Null for a thing without a type (a quick capture, an import). */
  typeId: string | null;
  placeId: string | null;
  containerId: string | null;
  /** A decimal string (D183). */
  quantity: string;
  aliases: Record<string, string[]>;
  lifecycle: Lifecycle;
  reviewState: 'draft' | 'confirmed';
  locationUncertain: boolean;
  lastSeenAt: string | null;
  coverFileId: string | null;
  isContainer: boolean;
  /**
   * Its meters, oldest first (READING's target list offline). The server always sends it; a row
   * the phone made itself (a capture not yet synced) has none.
   */
  meters?: SnapMeter[];
  /**
   * Step 4: the loan and repair states derived on the server (D119), so the offline path reads
   * "with Murdock · due 17 Oct". Absent means none. Additive: no payload version change.
   */
  derived?: ('lent' | 'borrowed' | 'in_repair')[];
  /** The open loan, if any: a person's name is not a contact detail; no phone, email or notes
   * ever reach the phone (D36; step-4 plan Q34). */
  loan?: { direction: LoanDirection; personName: string; dueOn: string | null };
  deleted: boolean;
};

export type SnapCode = {
  code: string;
  locationId: string;
  thingId: string | null;
  placeId: string | null;
  state: 'blank' | 'assigned' | 'retired';
  isPrimary: boolean;
};

/** Keyed by location, source, collection and code (the table's primary key); `legacyCodeKey()`
 * makes that one string, for the phone's table and a `removed` entry's `entityId`. */
export type SnapLegacyCode = {
  locationId: string;
  source: string;
  sourceCollection: string;
  code: string;
  thingId: string | null;
  placeId: string | null;
};

/** The key of a legacy code on the phone and in `removed`: `locationId:source:collection:code`. */
export const legacyCodeKey = (
  c: Pick<SnapLegacyCode, 'locationId' | 'source' | 'sourceCollection' | 'code'>,
) => `${c.locationId}:${c.source}:${c.sourceCollection}:${c.code}`;

/**
 * Something that left a location (§7.4 tombstones, D156): purged, merged away, converted, or
 * moved to another location. It says "not in `locationId` any more", so the phone removes it only
 * where it holds it in that location: a thing moved to another location the person also sees
 * arrives there in `changes` (the same pass, or the next), and its old location's tombstone must
 * not delete it.
 *
 * A removed thing or place also takes with it the codes and legacy codes of that location that
 * point at it: they left with it (a move carries them along) or went with it (a purge).
 *
 * `entityId` is the thing's or place's id, the code itself for `code`, and `legacyCodeKey()` for
 * `legacy_code`. Step 3 writes tombstones for things, places and, since 0046, legacy codes (own
 * codes included, `kept.tombstone_legacy_code()`): a code removed while its thing or place stays.
 * No `code` tombstone is written yet: short IDs are never deleted, and a code that moves goes
 * with its thing; the kind is there for a removal that leaves its target in place.
 */
export type SnapRemoved = {
  locationId: string;
  entityType: 'thing' | 'place' | 'code' | 'legacy_code';
  entityId: string;
};

export type SnapshotPage = {
  /** Server time of this page. */
  asOf: string;
  payloadVersion: number;
  minPayloadVersion: number;
  /** Every visible location, in full, on every page. A pass starts afresh for a location the
   * person joined during it (`complete: false` until it has been read). */
  locations: SnapLocation[];
  /** `items` only when the hash differs from the `typesHash` the phone sent. */
  types: { hash: string; items?: SnapType[] };
  changes: {
    places: SnapPlace[];
    things: SnapThing[];
    codes: SnapCode[];
    legacyCodes: SnapLegacyCode[];
  };
  removed: SnapRemoved[];
  revokedLocationIds: string[];
  /** Opaque and signed; the phone never reads it. One that no longer verifies (the server's
   * auth secret changed) is a 400 `validation`: drop it and the cached copy, and pull afresh. */
  nextCursor: string;
  complete: boolean;
  /** Past `SYNC_LIMITS.snapshotThings`: "Only part of your Kept is on this phone" (Q30). */
  truncated?: boolean;
};
