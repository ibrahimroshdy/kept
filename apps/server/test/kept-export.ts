import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_ENTITIES,
  EXPORT_FORMAT,
  EXPORT_PATHS,
  EXPORT_VERSION,
  type ExportEntity,
  type ExportManifest,
  type ExportSecretRecord,
  newId,
  PASSPHRASE_KDF,
} from '@kept/shared';
import type { SecretKeys } from '../src/crypto/keyring.js';
import { withScope } from '../src/db/scope.js';
import { readEntity } from '../src/exports/data.js';
import { historyViewer, readHistory } from '../src/exports/history.js';
import { REGISTRY } from '../src/exports/registry.js';
import { readSecrets } from '../src/exports/secrets.js';
import {
  deriveKey,
  encryptSecrets,
  type KdfParams,
  newSalt,
} from '../src/portability/passphrase.js';
import { writeArchive } from '../src/portability/zip/write.js';
import { type FileStorage, importArchiveKey, originalKey } from '../src/storage/blob-store.js';
import type { TestDb } from './db.js';
import { ownerTx } from './tenancy.js';

// A Kept export made in a test, from the export registry's own readers (exports/data.ts,
// history.ts, secrets.ts) and the archive writer: what the export job writes, without its run and
// route. The Kept importer's tests (imports/kept/) read it; `mutate` lets a test break it on
// purpose (a newer version, a file left out). The round trip (test/portability) uses the real
// export job instead.

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

export type ForgedExport = {
  file: string;
  bytes: number;
  sha256: string;
  manifest: ExportManifest;
  cleanup: () => Promise<void>;
};

export type ForgeOptions = {
  userId: string;
  locationId: string;
  files: FileStorage;
  keys?: SecretKeys;
  /** With it, `secrets.json` holds the location's secret values under this passphrase. */
  passphrase?: string;
  /** Changes the manifest or drops entries before the archive is written. */
  mutate?: (m: ExportManifest, entries: Map<string, Buffer | null>) => void;
};

export async function forgeKeptExport(db: TestDb, opts: ForgeOptions): Promise<ForgedExport> {
  const scope = { userId: opts.userId, mfa: true };
  const exportId = newId();
  const dir = await mkdtemp(path.join(tmpdir(), 'kept-export-'));
  const entries = new Map<string, Buffer | null>();
  const fileEntries: { name: string; key: string; mime: string }[] = [];
  const manifest = await withScope(db.pools.app, scope, async (tx, client) => {
    const { rows } = await client.query<{
      name: string;
      kind: string;
      timezone: string;
      currency: string;
      languages: string[];
      account: string;
      modules: string[];
    }>(
      `SELECT l.name, l.kind, l.timezone, l.currency, l.languages,
              l.owner_account_id AS account,
              ARRAY(SELECT m.module FROM public.location_modules m
                     WHERE m.location_id = l.id AND m.enabled ORDER BY m.module) AS modules
         FROM public.locations l WHERE l.id = $1`,
      [opts.locationId],
    );
    const loc = rows[0];
    if (!loc) throw new Error('forgeKeptExport: no such location');
    const ctx = {
      locationId: opts.locationId,
      accountId: loc.account,
      showMoney: true,
      ended: true,
      trashed: false,
    };
    const counts = Object.fromEntries(EXPORT_ENTITIES.map((e) => [e, 0])) as Record<
      ExportEntity,
      number
    >;
    const files: ExportManifest['files'] = [];
    for (const def of REGISTRY) {
      const lines: string[] = [];
      for await (const row of readEntity(client, def, ctx)) {
        lines.push(JSON.stringify(row));
        if (def.entity === 'files') {
          const id = String(row.id);
          const mime = String(row.mime);
          const name = EXPORT_PATHS.file(id, EXT[mime] ?? 'bin');
          files.push({
            id,
            path: name,
            sha256: String(row.sha256),
            bytes: Number(row.bytes),
            mime,
          });
          fileEntries.push({ name, key: originalKey(opts.locationId, id), mime });
        }
      }
      counts[def.entity] = lines.length;
      entries.set(EXPORT_PATHS.data(def.entity), Buffer.from(lines.map((l) => `${l}\n`).join('')));
    }
    const viewer = await historyViewer(tx, client, scope, opts.locationId);
    const history: string[] = [];
    for await (const e of readHistory(client, opts.locationId, viewer)) {
      history.push(JSON.stringify(e));
    }
    counts.history = history.length;
    entries.set(EXPORT_PATHS.data('history'), Buffer.from(history.map((l) => `${l}\n`).join('')));

    let secretsCount = 0;
    if (opts.passphrase && opts.keys) {
      const records: ExportSecretRecord[] = [];
      for await (const r of readSecrets(client, opts.keys, ctx)) records.push(r);
      secretsCount = records.length;
      const salt = newSalt();
      const kdf = PASSPHRASE_KDF as unknown as KdfParams;
      const key = await deriveKey(opts.passphrase, salt, kdf);
      const plain = Buffer.from(records.map((r) => `${JSON.stringify(r)}\n`).join(''));
      entries.set(
        EXPORT_PATHS.secrets,
        Buffer.from(JSON.stringify(encryptSecrets(key, { salt, kdf }, exportId, plain))),
      );
    }
    const m: ExportManifest = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      keptVersion: 'test',
      exportId,
      createdAt: new Date().toISOString(),
      createdBy: { displayName: 'Ibrahim' },
      scope: 'location',
      location: {
        id: opts.locationId,
        name: loc.name,
        kind: loc.kind,
        timezone: loc.timezone,
        currency: loc.currency,
        languages: loc.languages,
        modules: loc.modules,
      },
      options: { ...DEFAULT_EXPORT_OPTIONS, ended: true },
      counts,
      moneyHidden: false,
      includesSecrets: secretsCount > 0 || !!opts.passphrase,
      secretsCount,
      members: [{ name: 'Bruce', role: 'admin' }],
      files,
      readable: { included: false, pdf: 'off' },
    };
    return m;
  });

  for (const f of fileEntries) entries.set(f.name, null);
  opts.mutate?.(manifest, entries);
  const file = path.join(dir, 'export.zip');
  const written = await writeArchive(file, async (zip) => {
    zip.addBuffer(EXPORT_PATHS.manifest, JSON.stringify(manifest));
    for (const [name, data] of entries) {
      if (data) {
        zip.addBuffer(name, data);
        continue;
      }
      const f = fileEntries.find((x) => x.name === name);
      if (!f) continue;
      zip.addStream(name, () => opts.files.blobs.stream(f.key), {
        contentType: f.mime,
      });
    }
  });
  return {
    file,
    ...written,
    manifest,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Puts an export where an uploaded archive goes (`i/<runId>.zip`) and makes its run, as the
 * archive upload (plan T8) leaves it: a Kept import of `userId`'s, targeting `locationId`, in
 * `status`.
 */
export async function stageKeptRun(
  db: TestDb,
  files: FileStorage,
  forged: Pick<ForgedExport, 'file' | 'bytes' | 'sha256' | 'manifest'>,
  opts: { userId: string; locationId: string; status?: 'draft' | 'checked' | 'running' },
): Promise<string> {
  const runId = newId();
  await files.blobs.put(importArchiveKey(runId), forged.file, {
    contentType: 'application/zip',
    bytes: forged.bytes,
  });
  await ownerTx(db, (c) =>
    c.query(
      `INSERT INTO public.import_runs (id, location_id, source, source_version, status, created_by,
                                       archive_bytes, archive_sha256, archive_ready_at)
       VALUES ($1, $2, 'kept_zip', $3, $4, $5, $6, $7, now())`,
      [
        runId,
        opts.locationId,
        forged.manifest.keptVersion,
        opts.status ?? 'running',
        opts.userId,
        forged.bytes,
        forged.sha256,
      ],
    ),
  );
  return runId;
}
