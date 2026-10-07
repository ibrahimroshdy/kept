import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Digits, KEPT_VERSION } from '@kept/shared';
import pg from 'pg';
import type { Pools } from '../../db/pools.js';
import { esc, page } from '../../exports/readable/html.js';
import { buildReadableCopy, type ReadableDeps } from '../../exports/readable/index.js';
import { AppError } from '../../http/errors.js';
import type { FileStorage } from '../../storage/blob-store.js';
import type { ReadableCopy } from '../nightly.js';
import { markerOf, storedMarker, writeMarker } from './cache.js';
import { placeFiles } from './sink.js';

// The readable copy in every snapshot (D159; step-8 plan T6, Q10, Q11). Before restic runs, the
// nightly snapshot (backup/nightly.ts, step 6) has this write KEPT_DATA_DIR/backup/readable/:
//
//   index.html                 every location: its name, kind, owner, counts, when it was written,
//                              or why it isn't here tonight
//   README.txt                 how to open it, with nothing but a browser
//   <locationId>/index.html …  step 7's readable copy of that location (exports/readable/), as
//                              its OWNER sees it (Q10): read on the kept_app pool in the owner's
//                              scope, under row-level security, so money shows as the owner sees
//                              it and a secret never does
//   <locationId>/files/        the originals its pages link to (sink.ts: hard links with local
//                              storage; downloads with S3, photos as their display rendition)
//
// A location whose marker (cache.ts) hasn't changed since the last run is left exactly as it is.
// A changed one is written beside the old tree and swapped in whole, so a crash never leaves half a
// copy. A location that fails is listed as "not included tonight" with its error code and the run
// becomes a `warning` (nightly.ts), never a failure. A location in its deletion grace is listed
// too, without a copy: row-level security hides a deleted location from its owner (0006), and its
// rows are in the snapshot's dump. Trees of locations that no longer exist are removed.

export type ReadableTreeDeps = {
  /** kept_owner: the list of locations, their owners and markers (no RLS). */
  ownerUrl: string;
  /** kept_app: each copy is read in its owner's scope. */
  pools: Pick<Pools, 'app'>;
  files: FileStorage;
  storage: 'local' | 's3';
  /** KEPT_PUBLIC_URL (the PDF's footer). */
  publicUrl: string;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  render?: ReadableDeps['render'];
  /** The inventory PDF per location, within the report's cap (default on). */
  pdf?: boolean;
  version?: string;
  now?: () => Date;
};

export type ReadableTreeOptions = {
  /** One location only (`kept admin readable --location`): the others' trees are left alone. */
  locationId?: string;
};

type LocationRow = {
  id: string;
  name: string;
  kind: string;
  deleted: boolean;
  owner_user_id: string;
  owner_name: string | null;
  locale: string | null;
  digits: string | null;
};

export type ReadableEntry = {
  locationId: string;
  name: string;
  kind: string;
  owner: string;
  state: 'written' | 'unchanged' | 'failed' | 'deleted';
  things: number | null;
  places: number | null;
  error: string | null;
  missingFiles: number;
};

export type ReadableTreeResult = {
  locations: ReadableEntry[];
  /** Bytes of the tree, each file once (a hard link to a blob counts as the blob's size). */
  bytes: number;
  failed: { locationId: string; error: string }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A short code for a location that failed: never a message that could hold data. */
export function readableErrorOf(err: unknown): string {
  if (err instanceof AppError) return err.code;
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[a-z][a-z0-9_]{1,40}$/.test(code)) return code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return 'file_error';
  return 'readable_failed';
}

async function listLocations(ownerUrl: string): Promise<LocationRow[]> {
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'kept-readable' });
  client.on('error', () => {});
  await client.connect();
  try {
    const { rows } = await client.query<LocationRow>(
      `SELECT l.id, l.name, l.kind, l.deleted_at IS NOT NULL AS deleted,
              oa.user_id AS owner_user_id, p.display_name AS owner_name, p.locale, p.digits
         FROM public.locations l
         JOIN public.owner_accounts oa ON oa.id = l.owner_account_id
         LEFT JOIN public.user_profiles p ON p.user_id = oa.user_id
        ORDER BY lower(coalesce(p.display_name, '')), lower(l.name), l.id`,
    );
    return rows;
  } finally {
    await client.end().catch(() => {});
  }
}

async function withOwner<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: 'kept-readable' });
  client.on('error', () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Sum of the tree's file sizes, each inode once. */
async function treeBytes(dir: string): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  const walk = async (d: string) => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(d, name);
      const s = await lstat(full).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) await walk(full);
      else if (s.isFile()) {
        const id = `${s.dev}:${s.ino}`;
        if (seen.has(id)) continue;
        seen.add(id);
        total += s.size;
      }
    }
  };
  await walk(dir);
  return total;
}

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

/** Writes (or keeps) every location's readable copy under `dir`, then the top index. */
export async function writeReadableTree(
  deps: ReadableTreeDeps,
  dir: string,
  opts: ReadableTreeOptions = {},
): Promise<ReadableTreeResult> {
  const version = deps.version ?? KEPT_VERSION;
  const pdf = deps.pdf ?? true;
  const now = deps.now ?? (() => new Date());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const all = await listLocations(deps.ownerUrl);
  const rows = opts.locationId ? all.filter((l) => l.id === opts.locationId) : all;
  const entries: ReadableEntry[] = [];

  for (const loc of rows) {
    const entry: ReadableEntry = {
      locationId: loc.id,
      name: loc.name,
      kind: loc.kind,
      owner: loc.owner_name ?? '',
      state: 'written',
      things: null,
      places: null,
      error: null,
      missingFiles: 0,
    };
    entries.push(entry);
    const locDir = path.join(dir, loc.id);
    if (loc.deleted) {
      entry.state = 'deleted';
      await rm(locDir, { recursive: true, force: true });
      continue;
    }
    const locale = loc.locale ?? 'en';
    const digits: Digits = loc.digits === 'eastern' ? 'eastern' : 'western';
    try {
      const marker = await withOwner(deps.ownerUrl, (c) =>
        markerOf(c, {
          locationId: loc.id,
          ownerUserId: loc.owner_user_id,
          locale,
          digits,
          version,
          storage: deps.storage,
          pdf,
        }),
      );
      const stored = await storedMarker(locDir);
      if (stored === marker && (await exists(path.join(locDir, 'index.html')))) {
        entry.state = 'unchanged';
        const counts = await countsOf(locDir);
        entry.things = counts.things;
        entry.places = counts.places;
        continue;
      }
      // Written beside the old tree, then swapped in whole.
      const next = path.join(dir, `.next-${loc.id}-${randomUUID()}`);
      try {
        const result = await buildReadableCopy(
          {
            pools: deps.pools,
            files: deps.files,
            publicUrl: deps.publicUrl,
            log: deps.log,
            ...(deps.render ? { render: deps.render } : {}),
            now,
          },
          { userId: loc.owner_user_id, mfa: true },
          loc.id,
          {
            dir: next,
            filesHref: 'files',
            ...(deps.storage === 's3' ? { photos: 'display' as const } : {}),
          },
          { locale, digits, ended: true, trashed: false, pdf },
        );
        const placed = await placeFiles(next, result.files, {
          storage: deps.storage,
          blobs: deps.files.blobs,
          previousDir: (await exists(locDir)) ? locDir : null,
          log: deps.log,
        });
        entry.things = result.things;
        entry.places = result.places;
        entry.missingFiles = placed.missing;
        await writeMarker(next, marker);
        await writeFile(
          path.join(next, '.kept-counts.json'),
          `${JSON.stringify({ things: result.things, places: result.places })}\n`,
          { mode: 0o600 },
        );
        const old = path.join(dir, `.old-${loc.id}-${randomUUID()}`);
        const had = await exists(locDir);
        if (had) await rename(locDir, old);
        await rename(next, locDir);
        if (had) await rm(old, { recursive: true, force: true });
      } finally {
        await rm(next, { recursive: true, force: true });
      }
    } catch (err) {
      entry.state = 'failed';
      entry.error = readableErrorOf(err);
      deps.log.error(
        { locationId: loc.id, error: entry.error, err: String(err).slice(0, 300) },
        'readable copy: a location was not written',
      );
      await rm(locDir, { recursive: true, force: true });
    }
  }

  // Trees of locations that are gone, and leftovers of an interrupted run.
  if (!opts.locationId) {
    const known = new Set(all.map((l) => l.id));
    for (const name of await readdir(dir)) {
      const leftover = name.startsWith('.next-') || name.startsWith('.old-');
      if (leftover || (UUID.test(name) && !known.has(name))) {
        await rm(path.join(dir, name), { recursive: true, force: true });
      }
    }
    await writeFile(path.join(dir, 'index.html'), topIndex(entries, now()), { mode: 0o600 });
    const readme = path.join(dir, 'README.txt');
    if ((await readFile(readme, 'utf8').catch(() => '')) !== README) {
      await writeFile(readme, README, { mode: 0o600 });
    }
  }

  const failed = entries
    .filter((e) => e.state === 'failed')
    .map((e) => ({ locationId: e.locationId, error: e.error ?? 'readable_failed' }));
  return { locations: entries, bytes: await treeBytes(dir), failed };
}

async function countsOf(locDir: string): Promise<{ things: number | null; places: number | null }> {
  try {
    const parsed = JSON.parse(await readFile(path.join(locDir, '.kept-counts.json'), 'utf8')) as {
      things?: unknown;
      places?: unknown;
    };
    return {
      things: typeof parsed.things === 'number' ? parsed.things : null,
      places: typeof parsed.places === 'number' ? parsed.places : null,
    };
  } catch {
    return { things: null, places: null };
  }
}

/** The nightly snapshot's step 6 (nightly.ts SnapshotDeps.readable). */
export function readableCopy(deps: ReadableTreeDeps): ReadableCopy {
  return async (dir) => {
    const result = await writeReadableTree(deps, dir);
    const written = result.locations.filter((l) => l.state !== 'failed' && l.state !== 'deleted');
    return { locations: written.length, bytes: result.bytes, failed: result.failed };
  };
}

// ---------------------------------------------------------------------------------------------
// The top index and the README: English, plain, no script; names isolated (they may be Arabic).

const KIND_LABELS: Record<string, string> = {
  personal: 'Personal',
  home: 'Home',
  apartment: 'Apartment',
  garage: 'Garage',
  storage_unit: 'Storage unit',
  office: 'Office',
  vacation_home: 'Vacation home',
  custom: 'Other',
};

const bdi = (s: string) => (s ? `<bdi>${esc(s)}</bdi>` : '');

function topIndex(entries: ReadableEntry[], at: Date): string {
  const n = (v: number | null) => (v === null ? '' : String(v));
  const rows = entries
    .map((e) => {
      const name =
        e.state === 'written' || e.state === 'unchanged'
          ? `<a href="${esc(e.locationId)}/index.html">${bdi(e.name)}</a>`
          : bdi(e.name);
      const note =
        e.state === 'failed'
          ? `Not included tonight (${esc(e.error ?? 'readable_failed')}). The database in this backup still holds it.`
          : e.state === 'deleted'
            ? 'Being deleted: not included. The database in this backup still holds it.'
            : e.missingFiles > 0
              ? `${e.missingFiles} file(s) were missing from the file store.`
              : '';
      return `<tr><td data-label="Location">${name}</td><td data-label="Kind">${esc(
        KIND_LABELS[e.kind] ?? e.kind,
      )}</td><td data-label="Owner">${bdi(e.owner)}</td><td data-label="Things">${n(
        e.things,
      )}</td><td data-label="Places">${n(e.places)}</td><td data-label="Note">${note}</td></tr>`;
    })
    .join('\n');
  const body = `<h1><span class="tape">Kept</span> backup: every location</h1>
<p class="muted">Written ${esc(at.toISOString().replace('T', ' ').slice(0, 16))} UTC. Each location opens in any browser, with no network and no Kept.</p>
<table>
<thead><tr><th>Location</th><th>Kind</th><th>Owner</th><th>Things</th><th>Places</th><th></th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6">No locations.</td></tr>'}
</tbody>
</table>`;
  return page({ lang: 'en', dir: 'ltr' }, 'Kept backup', body);
}

const README = `Kept: the readable copy of every location
==========================================

This folder is part of a Kept backup. It needs nothing but a web browser and, for the .csv
files, a spreadsheet: no Kept, no database, no network.

  index.html            every location in this backup; open it in a browser
  <id>/index.html       one location: its places and things, with photos and documents
  <id>/*.csv            the same data as spreadsheets (things, places, purchases, warranties, ...)
  <id>/inventory.pdf    a printable inventory, for locations of up to 2,000 things
  <id>/files/           the photos, receipts and documents the pages link to

Each location is written as its owner sees it. Secrets (safe combinations, alarm codes and the
like) are never in this copy; they are only in the encrypted database dump beside it
(backup/db/), which Kept's recovery kit opens.

To get this folder out of a restic backup without Kept:

  restic -r <repository> restore latest --target ./kept-backup --include /backup/readable

then open ./kept-backup/backup/readable/index.html.
`;
