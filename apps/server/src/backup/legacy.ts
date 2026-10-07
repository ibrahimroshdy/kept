import type { ResolvedBackupTarget } from './settings.js';
import { type BackupTarget, LocalDirTarget, S3Target } from './target.js';

// The alpha's backups (T31c, D207), read-only (step-8 plan T5, Q1, Q2). The alpha wrote
// `runs/<id>/{db.dump,manifest.json}` and `blobs/<key>` straight into a directory or an S3 prefix;
// restic's repository now lives in `restic/` beside them. Nothing writes that layout any more:
// it stays listable and restorable with `kept admin restore --legacy <id>` for one release, and
// the operator removes it when the status page says the old runs can go.

const RUN = /^runs\/([0-9TZ]+-[0-9a-f]{6})\/(db\.dump|manifest\.json)$/;
export const LEGACY_RUN_ID = /^[0-9TZ]+-[0-9a-f]{6}$/;

/** The alpha layout in a target, or null for SFTP (the alpha never wrote there). */
export function legacyTargetOf(t: ResolvedBackupTarget): BackupTarget | null {
  if (t.kind === 'dir') return new LocalDirTarget(t.path);
  if (t.kind === 's3') {
    return new S3Target({
      bucket: t.bucket,
      prefix: t.prefix,
      region: t.region,
      endpoint: t.endpoint ?? undefined,
      forcePathStyle: t.forcePathStyle,
      credentials: { accessKeyId: t.accessKeyId, secretAccessKey: t.secretAccessKey },
    });
  }
  return null;
}

/** The alpha's complete runs in a target (a manifest marks one complete), newest first. */
export async function legacyRuns(target: BackupTarget): Promise<string[]> {
  const names = await target.list('runs/');
  return names
    .map((n) => RUN.exec(n))
    .filter((m): m is RegExpExecArray => m?.[2] === 'manifest.json')
    .map((m) => m[1] as string)
    .sort()
    .reverse();
}
