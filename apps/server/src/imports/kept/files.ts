import { rm } from 'node:fs/promises';
import { FILE_CLASSES, type FileClass } from '@kept/shared';
import { type Scope, withScope } from '../../db/scope.js';
import { type IngestDeps, ingestFile } from '../../files/ingest.js';
import { type Received, receive } from '../../files/upload.js';
import { AppError } from '../../http/errors.js';
import type { OpenArchive } from '../../portability/zip/read.js';
import type { IdMap } from './ids.js';

// An export's original files on import (D117, D157; step-7 plan T14). Each `files/<fileId>` the
// export's `files` rows name is streamed out of the archive by receive() (files/upload.ts) into a
// temp file with a random name (never anything from the archive), hashed and counted on the way, checked against the
// manifest's SHA-256, and handed to ingestFile(): sniffed, deduplicated in the location,
// resized and stored exactly as an upload is, audited `file.import`. A file whose entry is
// missing or differs from the manifest is `file_missing`; one the sniffer refuses is
// `file_type_refused`; one over the upload limit `file_too_large`. Its attachments and covers are
// then left out, and the thing imports without them.

export type FileOutcome =
  | { status: 'inserted' | 'existing' | 'matched'; newId: string }
  | { status: 'skipped'; code: 'file_missing' | 'file_type_refused' | 'file_too_large' };

export type ExportedFile = { id: string; sha256?: string | null; class?: string | null };

/** The manifest's originals by (old) id: the entry each is stored under, and its SHA-256. */
export type Originals = Map<string, { path: string; sha256: string }>;

export const originalsOf = (files: readonly { id: string; path: string; sha256: string }[]) =>
  new Map(files.map((f) => [f.id.toLowerCase(), { path: f.path, sha256: f.sha256 }]));

const classOf = (value: unknown): FileClass =>
  (FILE_CLASSES as readonly string[]).includes(String(value)) ? (value as FileClass) : 'document';

/** Imports one file row of run `runId` as `scope` into `locationId`. */
export async function importFile(
  deps: IngestDeps,
  scope: Scope,
  archive: OpenArchive,
  ctx: { runId: string; locationId: string; ids: IdMap; originals: Originals },
  row: ExportedFile,
): Promise<FileOutcome> {
  const oldId = row.id.toLowerCase();
  const fileId = ctx.ids.of(oldId);
  const already = await withScope(deps.pools.app, scope, async (_tx, client) => {
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.files WHERE id = $1 AND location_id = $2',
      [fileId, ctx.locationId],
    );
    return (rowCount ?? 0) > 0;
  });
  if (already) return { status: 'existing', newId: fileId };

  const original = ctx.originals.get(oldId);
  if (!original || !archive.has(original.path)) return { status: 'skipped', code: 'file_missing' };
  const entry = original.path;
  const expected = original.sha256;

  let received: Received;
  try {
    received = await receive(await archive.read(entry), deps.files.tmpDir, deps.files.maxFileBytes);
  } catch (err) {
    if (err instanceof AppError && err.status === 413) {
      return { status: 'skipped', code: 'file_too_large' };
    }
    throw err;
  }
  const { file: tmp, sha256, bytes } = received;
  try {
    if (expected && expected !== sha256) return { status: 'skipped', code: 'file_missing' };
    try {
      const done = await ingestFile(
        deps,
        scope,
        {
          file: tmp,
          sha256,
          bytes,
          fileId,
          locationId: ctx.locationId,
          class: classOf(row.class),
        },
        { auditAction: 'file.import', requestId: `import:${ctx.runId}` },
      );
      const deduplicated = 'deduplicatedFrom' in done.body ? done.body.deduplicatedFrom : undefined;
      if (typeof deduplicated === 'string' && deduplicated !== fileId) {
        ctx.ids.match(oldId, deduplicated);
        return { status: 'matched', newId: deduplicated };
      }
      return { status: done.status === 201 ? 'inserted' : 'existing', newId: fileId };
    } catch (err) {
      if (err instanceof AppError && err.status === 415) {
        return { status: 'skipped', code: 'file_type_refused' };
      }
      if (err instanceof AppError && err.status === 413) {
        return { status: 'skipped', code: 'file_too_large' };
      }
      throw err;
    }
  } finally {
    await rm(tmp, { force: true });
  }
}
