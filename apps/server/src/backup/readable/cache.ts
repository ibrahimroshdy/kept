import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

// Unchanged locations are not rewritten (step-8 plan T6): each location's readable copy carries a
// marker, `.kept-readable.json`, of what it was written from. When tonight's marker is the same,
// the tree is left exactly as it is, so restic sees no changed file (and the PDF isn't rendered
// again). The marker is:
//   - the location's newest audit event (every write goes through audited(), step 2), and the
//     number of its display and thumbnail renditions (made after an upload, unaudited);
//   - the owner's language and digits (the copy is written in them) and the owner account;
//   - the Kept version (a new release may write the copy differently), the file storage mode and
//     the copy's own options.
// It holds ids and settings only, never a name or a value. A location in its deletion grace has
// no marker: RLS hides it from its owner, so it has no copy (run.ts).

export const MARKER_FILE = '.kept-readable.json';

/** Bump when the tree's layout changes: every location is written again. */
export const MARKER_FORMAT = 1;

export type MarkerInput = {
  locationId: string;
  ownerUserId: string;
  locale: string;
  digits: string;
  version: string;
  storage: 'local' | 's3';
  pdf: boolean;
};

/** The marker of a location as it stands now, read as kept_owner. */
export async function markerOf(client: pg.ClientBase, input: MarkerInput): Promise<string> {
  const { rows } = await client.query<{ audit: string | null; renditions: number }>(
    `SELECT (SELECT e.id::text FROM public.audit_events e WHERE e.location_id = $1
              ORDER BY e.at DESC, e.id DESC LIMIT 1) AS audit,
            (SELECT count(*)::int FROM public.file_derivatives d
              WHERE d.location_id = $1 AND d.variant IN ('thumb', 'display')) AS renditions`,
    [input.locationId],
  );
  const r = rows[0];
  return JSON.stringify({
    format: MARKER_FORMAT,
    location: input.locationId,
    owner: input.ownerUserId,
    audit: r?.audit ?? null,
    renditions: r?.renditions ?? 0,
    locale: input.locale,
    digits: input.digits,
    version: input.version,
    storage: input.storage,
    pdf: input.pdf,
  });
}

/** The marker a location's tree was written with, or null (none, or unreadable). */
export async function storedMarker(locationDir: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(locationDir, MARKER_FILE), 'utf8');
    JSON.parse(text);
    return text.trim();
  } catch {
    return null;
  }
}

export async function writeMarker(locationDir: string, marker: string): Promise<void> {
  const file = path.join(locationDir, MARKER_FILE);
  const tmp = `${file}.${randomUUID()}.partial`;
  await writeFile(tmp, `${marker}\n`, { mode: 0o600 });
  await rename(tmp, file);
}
