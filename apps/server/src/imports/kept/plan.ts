import {
  EXPORT_PATHS,
  type ExportEntity,
  type ExportManifest,
  type ImportIssue,
  type Role,
} from '@kept/shared';
import type pg from 'pg';
import { entitySchema, HistoryEventSchema } from '../../exports/format.js';
import { entityDef } from '../../exports/registry.js';
import type { OpenArchive } from '../../portability/zip/read.js';
import { APPLY_ORDER, Known, NOT_APPLIED, type Row } from './apply.js';
import { codesFree } from './codes.js';
import { originalsOf } from './files.js';
import { inspectKept, readManifest } from './read.js';

// The Kept import's dry run (step-7 plan T14, Q27): it reads the whole archive and writes
// nothing. It reports what the import would make (places, things, attachments, files), which
// printed labels keep their code and which are re-issued (codesFree(): free or taken on this
// server, the one thing the adopt door would tell), the people to invite, the secrets the export
// holds (imported only with the passphrase), and how much history is within the two-year
// retention. Only rows with an issue are listed (Q27).
//
// The same scan gives the job its `Known` ids: every row id the archive holds, so a reference to
// a row the export left out (an ended thing, a trashed place) becomes nothing instead of a
// broken link.

const RETENTION_MS = 2 * 365.25 * 24 * 3600 * 1000;

export type KeptDryRunSummary = {
  places: number;
  things: number;
  attachments: number;
  files: number;
  codesAdopted: number;
  codesReissued: number;
  history: number;
  historyDropped: number;
  secrets: number;
  skipped: number;
  asText: number;
  members: { name: string; role: Role }[];
};

export type KeptReportRow = {
  status: 'ok' | 'text' | 'skipped';
  ref: NonNullable<ImportIssue['ref']>;
  issues: ImportIssue[];
};

export type KeptDryRunReport = {
  source: 'kept_zip';
  summary: KeptDryRunSummary;
  rows: KeptReportRow[];
};

export type Scan = {
  known: Known;
  /** Rows per entity file read. */
  counts: Map<ExportEntity, number>;
  /** History events, and how many fall within the retention. */
  history: { total: number; within: number };
  /** The codes on things and places (and blanks), as exported. */
  codes: { code: string; state: string; thingId: string | null; placeId: string | null }[];
  /** Names of things and places, for the report's rows. */
  names: Map<string, string>;
  /** File rows whose original isn't in the archive. */
  filesMissing: { id: string }[];
  /** The old Unplaced area: it becomes the new location's own. */
  unplaced: number;
};

/** Reads one entity's rows with the registry's schema for it. */
export async function* rowsOf(archive: OpenArchive, entity: ExportEntity): AsyncIterable<Row> {
  const name = EXPORT_PATHS.data(entity);
  if (!archive.has(name) || !entityDef(entity)) return;
  for await (const row of archive.ndjson(name, entitySchema(entity))) yield row as Row;
}

const HistoryHead = HistoryEventSchema.pick({ at: true });

/** Every row id of the archive, the counts, the codes and the history's dates. */
export async function scanArchive(
  archive: OpenArchive,
  manifest: ExportManifest,
  now = Date.now(),
): Promise<Scan> {
  const known = new Known();
  known.add(manifest.location.id);
  const counts = new Map<ExportEntity, number>();
  const codes: Scan['codes'] = [];
  const names = new Map<string, string>();
  const filesMissing: Scan['filesMissing'] = [];
  let unplaced = 0;
  const originals = originalsOf(manifest.files);
  for (const entity of APPLY_ORDER) {
    let n = 0;
    for await (const row of rowsOf(archive, entity)) {
      n += 1;
      known.add(row.id);
      if (entity === 'places' && row.isUnplaced === true) unplaced += 1;
      if ((entity === 'things' || entity === 'places') && typeof row.id === 'string') {
        names.set(row.id.toLowerCase(), String(row.name ?? ''));
      }
      if (entity === 'codes') {
        codes.push({
          code: String(row.code ?? '')
            .trim()
            .toUpperCase(),
          state: String(row.state ?? 'assigned'),
          thingId: typeof row.thingId === 'string' ? row.thingId.toLowerCase() : null,
          placeId: typeof row.placeId === 'string' ? row.placeId.toLowerCase() : null,
        });
      }
      if (entity === 'files' && typeof row.id === 'string') {
        const original = originals.get(row.id.toLowerCase());
        if (!original || !archive.has(original.path))
          filesMissing.push({ id: row.id.toLowerCase() });
      }
    }
    counts.set(entity, n);
  }
  const history = { total: 0, within: 0 };
  const historyName = EXPORT_PATHS.data('history');
  if (archive.has(historyName)) {
    for await (const e of archive.ndjson(historyName, HistoryHead)) {
      history.total += 1;
      const at = Date.parse(e.at);
      if (at <= now && at >= now - RETENTION_MS) history.within += 1;
    }
  }
  return { known, counts, history, codes, names, filesMissing, unplaced };
}

/** How many units the job works through: every row it applies, every file, every event. */
export function totalOf(scan: Scan): number {
  let total = scan.history.total;
  for (const entity of APPLY_ORDER) {
    if (!NOT_APPLIED.has(entity)) total += scan.counts.get(entity) ?? 0;
  }
  return total;
}

/** What a dry run reads from the archive, outside any transaction (plan T8's `load`). */
export type KeptLoaded = {
  manifest: ExportManifest;
  scan: Scan;
  members: { name: string; role: Role }[];
};

export async function loadKept(archive: OpenArchive): Promise<KeptLoaded> {
  const manifest = await readManifest(archive);
  const scan = await scanArchive(archive, manifest);
  const inspect = await inspectKept(archive);
  return { manifest, scan, members: inspect.kept.members };
}

/**
 * POST /imports/:id/dry-run for a Kept export (plan T8 dispatches here): the report, writing
 * nothing. `locationId` is the run's target, where the code probe tries the codes.
 */
export async function keptReport(
  client: pg.ClientBase,
  loaded: KeptLoaded,
  locationId: string,
): Promise<KeptDryRunReport> {
  const { manifest, scan } = loaded;
  const assigned = scan.codes.filter((c) => c.state === 'assigned' && (c.thingId || c.placeId));
  const free = await codesFree(
    client,
    locationId,
    assigned.map((c) => c.code),
  );
  const rows: KeptReportRow[] = [];
  let reissued = 0;
  for (const c of assigned) {
    if (free.has(c.code)) continue;
    reissued += 1;
    const id = (c.thingId ?? c.placeId) as string;
    rows.push({
      status: 'ok',
      ref: { kind: 'entity', id, name: scan.names.get(id) ?? '' },
      issues: [
        {
          column: '',
          code: 'code_taken',
          message:
            'This label’s code is in use on this server: it gets a new one, and the old label still opens it.',
        },
      ],
    });
  }
  for (const f of scan.filesMissing) {
    rows.push({
      status: 'skipped',
      ref: { kind: 'file', id: f.id },
      issues: [
        {
          column: '',
          code: 'file_missing',
          message: 'This file isn’t in the export; what it was attached to is imported without it.',
        },
      ],
    });
  }
  return {
    source: 'kept_zip',
    summary: {
      places: (scan.counts.get('places') ?? 0) - scan.unplaced,
      things: scan.counts.get('things') ?? 0,
      attachments: scan.counts.get('attachments') ?? 0,
      files: (scan.counts.get('files') ?? 0) - scan.filesMissing.length,
      codesAdopted: assigned.length - reissued,
      codesReissued: reissued,
      history: scan.history.within,
      historyDropped: scan.history.total - scan.history.within,
      secrets: manifest.includesSecrets ? manifest.secretsCount : 0,
      skipped: scan.filesMissing.length,
      asText: 0,
      members: loaded.members,
    },
    rows,
  };
}

/** The dry run on an open archive (tests; the route goes through the importer). */
export async function keptDryRun(
  client: pg.ClientBase,
  archive: OpenArchive,
  locationId: string,
): Promise<KeptDryRunReport> {
  return keptReport(client, await loadKept(archive), locationId);
}
