import {
  EXPORT_ENTITIES,
  EXPORT_FILE_PATH,
  EXPORT_FORMAT,
  EXPORT_PATHS,
  EXPORT_VERSION,
  type ExportEntity,
  type ExportManifest,
  ROLES,
  type Role,
} from '@kept/shared';
import { z } from 'zod';
import { ManifestSchema } from '../../exports/format.js';
import { ArchiveContentError, ArchiveError } from '../../portability/zip/limits.js';
import { expectNames, type OpenArchive, openArchive } from '../../portability/zip/read.js';
import { type BlobStore, importArchiveKey } from '../../storage/blob-store.js';

// Reading a Kept export (step-7 plan T14, Q5): the archive is opened through the one safe reader
// (portability/zip/, D157) by exact names only: `manifest.json`, `secrets.json`,
// `data/<entity>.ndjson` for the entities this server knows, and `files/<uuid>.<ext>` (the
// manifest names each original's entry, which must carry that original's id). Anything else
// (the readable copy, the AI-call CSVs, `me.json`) is counted and never opened.
//
// The manifest comes first: format `kept-export`, a version this server reads (a newer one is
// 400 `archive_invalid` with the reason `unsupported_version`: "This export is from a newer Kept;
// update this server first"). Each data file is then read line by line with the export
// registry's schema for its entity (exports/format.ts), so the writer and the reader can't drift.

/** The names a Kept export's reader opens. */
export const KEPT_EXPECT = expectNames(
  [
    EXPORT_PATHS.manifest,
    EXPORT_PATHS.secrets,
    ...EXPORT_ENTITIES.map((e) => EXPORT_PATHS.data(e)),
  ],
  [EXPORT_FILE_PATH],
);

/** The version first, alone, so a newer manifest is refused whatever else it holds. */
const ManifestHead = z.object({ format: z.string(), version: z.number().int() });

/** Opens run `runId`'s uploaded archive (`i/<runId>.zip`, `bytes` long). */
export function openKeptArchive(
  blobs: BlobStore,
  runId: string,
  bytes: number,
): Promise<OpenArchive> {
  return openArchive(blobs, importArchiveKey(runId), bytes, { expect: KEPT_EXPECT });
}

/**
 * The manifest, checked. ArchiveError `unsupported_version` for a newer export; ArchiveContentError
 * for a missing or malformed one (the caller fails the run with `archive_invalid`).
 */
export async function readManifest(archive: OpenArchive): Promise<ExportManifest> {
  const head = await archive.json(EXPORT_PATHS.manifest, ManifestHead);
  if (head.format !== EXPORT_FORMAT) {
    throw new ArchiveContentError(EXPORT_PATHS.manifest, 'schema');
  }
  if (head.version > EXPORT_VERSION) {
    throw new ArchiveError('unsupported_version', `version ${head.version}`);
  }
  const manifest = await archive.json(EXPORT_PATHS.manifest, ManifestSchema);
  // Each original's entry names its own id (`files/<id>.<ext>`); one that doesn't is refused.
  for (const f of manifest.files) {
    f.id = f.id.toLowerCase();
    if (EXPORT_FILE_PATH.exec(f.path)?.[1] !== f.id) {
      throw new ArchiveContentError(EXPORT_PATHS.manifest, 'schema');
    }
  }
  manifest.location.id = manifest.location.id.toLowerCase();
  manifest.exportId = manifest.exportId.toLowerCase();
  return manifest;
}

/** A member's role as the importer offers to invite them: one Kept knows, else member. */
const roleOf = (role: string): Role =>
  (ROLES as readonly string[]).includes(role) && role !== 'owner' ? (role as Role) : 'member';

/** What inspection shows of a Kept export (ArchiveInspect's `kept`, the web contract). */
export type KeptInspect = {
  locationName: string;
  kind: string;
  exportedAt: string;
  keptVersion: string;
  counts: Record<string, number>;
  includesSecrets: boolean;
  members: { name: string; role: Role }[];
};

/** POST /imports/:id/inspect for a Kept export (plan T8 calls it): the manifest only. */
export async function inspectKept(
  archive: OpenArchive,
): Promise<{ source: 'kept_zip'; sourceVersion: string; kept: KeptInspect }> {
  const m = await readManifest(archive);
  const counts: Record<string, number> = {};
  for (const e of EXPORT_ENTITIES) counts[e] = m.counts[e] ?? 0;
  return {
    source: 'kept_zip',
    sourceVersion: m.keptVersion,
    kept: {
      locationName: m.location.name,
      kind: m.location.kind,
      exportedAt: m.createdAt,
      keptVersion: m.keptVersion,
      counts,
      includesSecrets: m.includesSecrets && archive.has(EXPORT_PATHS.secrets),
      members: m.members.map((x) => ({ name: x.name, role: roleOf(x.role) })),
    },
  };
}

/** Whether the archive holds `entity`'s data file. */
export const hasEntity = (archive: OpenArchive, entity: ExportEntity): boolean =>
  archive.has(EXPORT_PATHS.data(entity));
