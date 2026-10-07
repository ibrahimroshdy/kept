import { createHmac } from 'node:crypto';

// The ids a Kept import gives what it makes (step-7 plan T14, Q8, Q9).
//
// Every id in an export is the exporting server's; nothing from an archive is used as an id here
// (D157). Each one becomes a new UUIDv7, derived from the run and the old id:
// - the first 48 bits (the time) are the old id's when it is a UUIDv7, so imported rows sort
//   among themselves as they did there (lists ordered by id); else the run's own time;
// - the other 74 bits are an HMAC-SHA256 of the old id keyed by the run's id, so two imports of
//   one export (into two locations, or onto the server it came from) never share an id.
// Being a function of (run, old id), the map needs no table to survive a resumed job: a chunk
// that runs again makes the same ids, and its inserts meet the rows already there. What an id
// became is still remembered in import_source_ids where its kind is one that table names.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value.toLowerCase());

const hex = (b: Buffer) => b.toString('hex');

/** The new id of `oldId` in run `runId` (both UUIDs). */
export function importedId(runId: string, oldId: string, runTimeMs: number): string {
  const old = oldId.toLowerCase();
  const mac = createHmac('sha256', Buffer.from(runId.toLowerCase().replaceAll('-', ''), 'hex'))
    .update(old, 'utf8')
    .digest();
  const out = Buffer.alloc(16);
  const oldBytes = Buffer.from(old.replaceAll('-', ''), 'hex');
  if (oldBytes.length === 16 && oldBytes[6] !== undefined && oldBytes[6] >> 4 === 7) {
    oldBytes.copy(out, 0, 0, 6);
  } else {
    out.writeUIntBE(Math.max(0, Math.floor(runTimeMs)) % 2 ** 48, 0, 6);
  }
  out[6] = 0x70 | ((mac[0] ?? 0) & 0x0f);
  out[7] = mac[1] ?? 0;
  out[8] = 0x80 | ((mac[2] ?? 0) & 0x3f);
  mac.copy(out, 9, 3, 10);
  const h = hex(out);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The run's id map: an old id's new one, unless a registry row was matched by name in the target
 * account (a type, brand, vendor, person, tag, place kind or template that already exists), or
 * the id is the exporting location's (the new location's).
 */
export class IdMap {
  private readonly matched = new Map<string, string>();

  constructor(
    readonly runId: string,
    readonly runTimeMs: number,
    readonly oldLocationId: string,
    readonly locationId: string,
  ) {}

  /** `oldId`'s id here. */
  of(oldId: string): string {
    const old = oldId.toLowerCase();
    if (old === this.oldLocationId) return this.locationId;
    return this.matched.get(old) ?? importedId(this.runId, old, this.runTimeMs);
  }

  /** `of()` for an optional reference. */
  ref(oldId: string | null | undefined): string | null {
    return oldId ? this.of(oldId) : null;
  }

  /** A registry row matched to an existing one here. */
  match(oldId: string, existingId: string): void {
    this.matched.set(oldId.toLowerCase(), existingId.toLowerCase());
  }

  isMatched(oldId: string): boolean {
    return this.matched.has(oldId.toLowerCase());
  }
}
