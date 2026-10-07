/**
 * Words for the backups' codes (step-8 T21; screens §8): a run's kind and state, why a run failed
 * or needs a look, and why Test couldn't open the repository. A screen shows these, never the
 * code itself ("A warning run explains itself in words, never a code", frame 106). Sizes read in
 * the person's language and digits.
 */
import type { BackupRun, BackupRunKind, BackupRunState, ResticErrorReason } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import { formatLocale, usePrefs } from '@/lib/prefs';

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** "2.1 GB", "412 KB", "316 B" (1024-based, as the disk reports). */
export function useSize(): (bytes: number) => string {
  const { locale, digits } = usePrefs();
  return useCallback(
    (bytes: number) => {
      let n = Math.max(0, bytes);
      let unit = 0;
      while (n >= 1024 && unit < UNITS.length - 1) {
        n /= 1024;
        unit += 1;
      }
      return new Intl.NumberFormat(formatLocale(locale, digits), {
        style: 'unit',
        unit: UNITS[unit],
        unitDisplay: 'short',
        maximumFractionDigits: unit >= 3 ? 1 : 0,
      }).format(n);
    },
    [locale, digits],
  );
}

export function useRunWords() {
  const { t } = useLingui();
  const kind = (k: BackupRunKind): string =>
    ({
      nightly: t`Nightly`,
      manual: t`Run now`,
      pre_upgrade: t`Before upgrade`,
      drill: t`Restore drill`,
      verify: t`Repository check`,
    })[k];
  const status = (s: BackupRunState): string =>
    ({
      running: t`Running`,
      ok: t`OK`,
      warning: t`Needs a look`,
      failed: t`Failed`,
    })[s];
  /** Why a run failed or needs a look, in words; null for a good one. */
  const explain = (run: Pick<BackupRun, 'status' | 'error'>): string | null => {
    if (run.status === 'ok' || run.status === 'running') return null;
    switch (run.error) {
      case 'backup_suspicious_size':
        return t`The dump was much smaller than the last good one. Older snapshots were kept.`;
      case 'readable_incomplete':
        return t`Some locations were left out of the readable copy. The database and files are in the snapshot.`;
      case 'files_unreadable':
        return t`Some files couldn't be read. The rest are in the snapshot.`;
      case 'blob_checksum_mismatch':
        return t`Some files don't match their checksums. They were backed up as they are.`;
      case 'unreachable':
      case 'backup_target_unreachable':
      case 'restic_unreachable':
        return t`Couldn't reach the backup storage. The next run tries again tonight.`;
      case 'restic_wrong_password':
      case 'wrong_password':
        return t`The repository was made with another password. Set that one in Backups.`;
      case 'restic_locked':
      case 'locked': {
        const unlock = 'kept admin backup unlock';
        return t`The repository is locked by another run. If none is running, ${unlock} removes the lock.`;
      }
      case 'restic_no_repository':
      case 'no_repository':
        return t`There is no repository at the target yet. Test creates one.`;
      case 'pg_version_mismatch':
        return t`The database dump tool doesn't match the database's version. Use Kept's own image.`;
      case 'pg_tool_failed':
        return t`The database dump failed. The server's log has the details.`;
      default:
        return run.status === 'failed'
          ? t`The backup failed. The server's log has the details.`
          : t`The snapshot was taken, but something needs a look. The server's log has the details.`;
    }
  };
  return { kind, status, explain };
}

/** Why Test couldn't open the repository (BackupTestResult.error), and what to do. */
export function useTestWords() {
  const { t } = useLingui();
  return (reason: ResticErrorReason | undefined): { title: string; body: string } => {
    switch (reason) {
      case 'wrong_password':
        return {
          title: t`Wrong password`,
          body: t`The repository there was made with another password. Enter that one, or choose an empty folder.`,
        };
      case 'unreachable':
        return {
          title: t`Couldn't reach it`,
          body: t`Kept got no answer from the backup storage. Check the address, the credentials and the network.`,
        };
      case 'locked':
        return {
          title: t`Locked`,
          body: t`Another run holds the repository. Try again when it finishes.`,
        };
      case 'no_repository':
        return {
          title: t`No repository there yet`,
          body: t`Create one now, or the first backup creates it.`,
        };
      default:
        return {
          title: t`Couldn't open it`,
          body: t`The backup tool failed. The server's log has the details.`,
        };
    }
  };
}
