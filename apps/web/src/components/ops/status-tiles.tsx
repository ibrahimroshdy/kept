/**
 * Admin → Status's step-8 tiles and notices (plan T21; D66, D144, D166, D181; frames 107, 108):
 * backups, the restore drill, the repository check, the file bucket's versioning, the disks, the
 * release, failed jobs and the update check. Loud, plain words ("No backup configured", "Last good
 * backup 3 days ago", "Backups are on the same disk as your data"); each warning tile links to its
 * fix. Every figure comes from the status response (rows the server already keeps, T10), never a
 * restic call. The recovery kit's tile is T22's (admin.status.tsx places it).
 */
import { DISK_WARN_RATIO, type UpdateCheckState } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { opsApi } from '@/api/ops/queries';
import type { StatusPageData } from '@/api/ops/types';
import { keys } from '@/api/queries';
import { AlertIcon, CheckCircleIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useRunWords, useSize } from './ops-words';

const DAY = 86_400_000;
/** A repository check older than this is overdue (the job runs weekly, T7). */
const VERIFY_DUE_DAYS = 14;

const linkClass =
  'w-fit text-small font-normal text-ink-2 underline underline-offset-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info';

/** One tile: a label, a headline with its state's icon, a plain sentence, and its fix. */
export function Tile({
  label,
  ok,
  children,
  detail,
  action,
}: {
  label: ReactNode;
  /** true: fine (a tick); false: needs a look (a warning); null: neither. */
  ok: boolean | null;
  children: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid content-start gap-1 rounded-[10px] border border-line bg-surface p-3.5">
      <div className="text-small text-ink-3">{label}</div>
      <div
        className={cn(
          'flex items-center gap-2 font-semibold text-[16px] [overflow-wrap:anywhere] [&_svg]:size-5 [&_svg]:shrink-0',
          ok === true && '[&_svg]:text-ok',
          ok === false && '[&_svg]:text-warn',
        )}
      >
        {ok === null ? null : ok ? <CheckCircleIcon /> : <AlertIcon />}
        <span className="min-w-0">{children}</span>
      </div>
      {detail ? <div className="text-small text-ink-2 [text-wrap:pretty]">{detail}</div> : null}
      {action ? <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">{action}</div> : null}
    </div>
  );
}

type Backup = NonNullable<StatusPageData['backup']>;

/** The notices above the tiles: what needs the admin now. */
export function OpsNotices({ s }: { s: StatusPageData }) {
  const f = useFormat();
  const backup = s.backup;
  const release = s.release;
  const lastGood = backup?.lastOk?.finishedAt ? f.relative(backup.lastOk.finishedAt) : null;
  const from = backup?.upgradeWithoutSnapshot?.fromVersion ?? '';
  const to = backup?.upgradeWithoutSnapshot?.toVersion ?? '';
  const newer = release?.rolledBackFrom ?? '';
  return (
    <>
      {backup && !backup.configured ? (
        <Notice
          tone="warn"
          title={<Trans>No backup configured</Trans>}
          action={
            <Link to="/admin/backups" className={linkClass}>
              <Trans>Set up backups</Trans>
            </Link>
          }
        >
          <Trans>
            Nothing on this server is backed up. Choose where backups go (another disk, an S3 bucket
            or an SFTP server) and a password in Backups.
          </Trans>
        </Notice>
      ) : null}
      {backup?.configured && backup.stale ? (
        <Notice
          tone="warn"
          title={
            lastGood ? (
              <Trans>Last good backup {lastGood}</Trans>
            ) : (
              <Trans>There is no good backup yet</Trans>
            )
          }
          action={
            <Link to="/admin/backups" className={linkClass}>
              <Trans>Open Backups</Trans>
            </Link>
          }
        >
          <Trans>
            Backups should run every night. Check the runs in Backups, and that Kept's worker is
            running.
          </Trans>
        </Notice>
      ) : null}
      {backup?.sameVolume ? (
        <Notice tone="warn" title={<Trans>Backups are on the same disk as your data</Trans>}>
          <Trans>
            If that disk fails, the backups go with it. Point the backup at another disk.
          </Trans>
        </Notice>
      ) : null}
      {backup?.upgradeWithoutSnapshot ? (
        <Notice
          tone="warn"
          title={
            <Trans>
              Upgraded from <span className="ltr">{from}</span> to <span className="ltr">{to}</span>{' '}
              without a backup
            </Trans>
          }
        >
          <Trans>No snapshot was taken before the upgrade. The next good backup clears this.</Trans>
        </Notice>
      ) : null}
      {release?.rolledBackFrom ? (
        <Notice
          tone="warn"
          title={
            <Trans>
              Running an older release on a database from <span className="ltr">{newer}</span>
            </Trans>
          }
        >
          <Trans>
            Kept allows one release back. Upgrade again when the problem that made you roll back is
            fixed.
          </Trans>
        </Notice>
      ) : null}
    </>
  );
}

function BackupsTile({ backup }: { backup: Backup }) {
  const f = useFormat();
  const size = useSize();
  const words = useRunWords();
  const last = backup.last;
  const lastOk = backup.lastOk;
  const open = (
    <Link to="/admin/backups" className={linkClass}>
      <Trans>Open Backups</Trans>
    </Link>
  );
  if (!backup.configured) {
    return (
      <Tile
        label={<Trans>Backups</Trans>}
        ok={false}
        action={
          <Link to="/admin/backups" className={linkClass}>
            <Trans>Set up backups</Trans>
          </Link>
        }
      >
        <Trans>No backup configured</Trans>
      </Tile>
    );
  }
  const needsLook =
    backup.stale || (last !== null && last.status !== 'ok' && last.status !== 'running');
  const why = last ? words.explain(last) : null;
  const repo = backup.repositoryBytes !== null ? size(backup.repositoryBytes) : null;
  const lastGood = lastOk?.finishedAt ? f.relative(lastOk.finishedAt) : null;
  return (
    <Tile
      label={<Trans>Backups</Trans>}
      ok={!needsLook}
      detail={why ? why : repo ? <Trans>{repo} in the repository</Trans> : null}
      action={open}
    >
      {lastGood ? <Trans>Last good backup {lastGood}</Trans> : <Trans>No good backup yet</Trans>}
    </Tile>
  );
}

function DrillTile({ backup }: { backup: Backup }) {
  const f = useFormat();
  const command = 'kept admin backup drill';
  const lastDrill = backup.lastDrillAt ? f.relative(backup.lastDrillAt) : null;
  return (
    <Tile
      label={<Trans>Restore drill</Trans>}
      ok={backup.configured ? !backup.drillDue : null}
      detail={
        <Trans>
          Once a month, restore into a scratch database and compare:{' '}
          <code className="ltr whitespace-nowrap">{command}</code>
        </Trans>
      }
    >
      {lastDrill ? <Trans>Last drill {lastDrill}</Trans> : <Trans>No drill yet</Trans>}
    </Tile>
  );
}

function VerifyTile({ backup }: { backup: Backup }) {
  const f = useFormat();
  const overdue =
    backup.configured &&
    (!backup.lastVerifyAt || Date.now() - Date.parse(backup.lastVerifyAt) > VERIFY_DUE_DAYS * DAY);
  const checkedAt = backup.lastVerifyAt ? f.relative(backup.lastVerifyAt) : null;
  return (
    <Tile
      label={<Trans>Repository check</Trans>}
      ok={backup.configured ? !overdue : null}
      detail={<Trans>Every week, Kept checks that every snapshot can be read.</Trans>}
    >
      {checkedAt ? <Trans>Checked {checkedAt}</Trans> : <Trans>Not checked yet</Trans>}
    </Tile>
  );
}

function VersioningTile({ backup }: { backup: Backup }) {
  const v = backup.bucketVersioning;
  return (
    <Tile
      label={<Trans>File bucket versioning</Trans>}
      ok={v === 'on' ? true : v === 'off' ? false : null}
      detail={
        v === 'off' ? (
          <Trans>
            With S3 file storage, a deleted or overwritten file can only come back if the bucket
            keeps versions. Turn versioning on in the bucket's settings.
          </Trans>
        ) : v === 'on' ? (
          <Trans>The bucket keeps earlier versions of every file.</Trans>
        ) : (
          <Trans>Kept checks it with each backup.</Trans>
        )
      }
    >
      {v === 'on' ? (
        <Trans>On</Trans>
      ) : v === 'off' ? (
        <Trans>Off</Trans>
      ) : (
        <Trans>Not known yet</Trans>
      )}
    </Tile>
  );
}

function DiskLine({
  label,
  usage,
}: {
  label: ReactNode;
  usage: { usedRatio: number; freeBytes: number };
}) {
  const f = useFormat();
  const size = useSize();
  const pct = f.num(Math.round(usage.usedRatio * 100));
  const free = size(usage.freeBytes);
  return (
    <span className="grid">
      <span>
        {label}: <Trans>{pct}% full</Trans>
      </span>
      <span className="font-normal text-small text-ink-2">
        <Trans>{free} free</Trans>
      </span>
    </span>
  );
}

function DiskTile({ disk }: { disk: NonNullable<StatusPageData['disk']> }) {
  const f = useFormat();
  const low = [disk.data, disk.backup].some((d) => d !== null && d.usedRatio >= DISK_WARN_RATIO);
  const warnAt = f.num(Math.round(DISK_WARN_RATIO * 100));
  return (
    <Tile
      label={<Trans>Disk</Trans>}
      ok={disk.data || disk.backup ? !low : null}
      detail={<Trans>Kept warns at {warnAt}%.</Trans>}
    >
      {disk.data || disk.backup ? (
        <span className="grid gap-1">
          {disk.data ? <DiskLine label={<Trans>Data</Trans>} usage={disk.data} /> : null}
          {disk.backup ? (
            <DiskLine label={<Trans context="disk">Backups</Trans>} usage={disk.backup} />
          ) : null}
        </span>
      ) : (
        <Trans>Not measured yet</Trans>
      )}
    </Tile>
  );
}

function ReleaseTile({ release }: { release: NonNullable<StatusPageData['release']> }) {
  const revision = release.revision?.slice(0, 7) ?? null;
  const migration = release.lastMigration?.match(/^\d+/)?.[0] ?? release.lastMigration;
  return (
    <Tile
      label={<Trans>Release</Trans>}
      ok={release.rolledBackFrom ? false : null}
      detail={
        revision || migration ? (
          <span className="grid">
            {revision ? (
              <span>
                <Trans>
                  Revision <span className="ltr">{revision}</span>
                </Trans>
              </span>
            ) : null}
            {migration ? (
              <span>
                <Trans>
                  Database at migration <span className="ltr">{migration}</span>
                </Trans>
              </span>
            ) : null}
          </span>
        ) : null
      }
      action={
        release.sourceUrl ? (
          <a href={release.sourceUrl} target="_blank" rel="noreferrer" className={linkClass}>
            <Trans>Source code</Trans>
          </a>
        ) : null
      }
    >
      <span className="ltr">{release.version}</span>
    </Tile>
  );
}

function JobsTile({ failed }: { failed: number }) {
  const n = useFormat().num(failed);
  return (
    <Tile
      label={<Trans>Failed jobs</Trans>}
      ok={failed === 0}
      detail={failed > 0 ? <Trans>They need a decision: retry or discard.</Trans> : null}
      action={
        failed > 0 ? (
          <Link to="/admin/jobs" className={linkClass}>
            <Trans>Failed jobs</Trans>
          </Link>
        ) : null
      }
    >
      {failed === 0 ? <Trans>None in the last day</Trans> : <Trans>{n} in the last day</Trans>}
    </Tile>
  );
}

/** The update check's state in words (D65; plan T11's errors). */
export function useUpdateWords() {
  const { t } = useLingui();
  return (u: UpdateCheckState): { title: string; detail: string | null; ok: boolean | null } => {
    if (!u.enabled) {
      return {
        title: t`Off`,
        detail: t`Kept doesn't ask for new versions. Turn it on in Admin → Sign-up.`,
        ok: null,
      };
    }
    if (u.latest) {
      const v = u.latest.version;
      return { title: t`Kept ${v} is available`, detail: null, ok: false };
    }
    switch (u.error) {
      case 'unreachable':
        return {
          title: t`Couldn't reach GitHub`,
          detail: t`The last check got no answer. Kept asks again tomorrow.`,
          ok: null,
        };
      case 'not_found':
        return {
          title: t`No releases found`,
          detail: t`GitHub shows no published release for this server's source repository. It may be private, or have none yet.`,
          ok: null,
        };
      case 'rate_limited':
        return {
          title: t`GitHub's limit reached`,
          detail: t`Too many requests came from this server's address. Kept asks again tomorrow.`,
          ok: null,
        };
      case 'not_github':
        return {
          title: t`Can't check this build`,
          detail: t`This server's source code address isn't a GitHub repository, so Kept doesn't ask.`,
          ok: null,
        };
      case 'bad_response':
        return {
          title: t`Couldn't read the answer`,
          detail: t`GitHub's answer wasn't what Kept expected. Kept asks again tomorrow.`,
          ok: null,
        };
      default:
        return u.lastCheckedAt
          ? { title: t`Up to date`, detail: null, ok: true }
          : { title: t`Not checked yet`, detail: null, ok: null };
    }
  };
}

function UpdatesTile({ updates }: { updates: UpdateCheckState }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const words = useUpdateWords()(updates);
  const check = useMutation({
    mutationFn: opsApi.checkUpdates,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.admin.status });
      toast({ title: t`Checked for new versions`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const checked = updates.lastCheckedAt ? f.relative(updates.lastCheckedAt) : null;
  return (
    <Tile
      label={<Trans>Updates</Trans>}
      ok={words.ok}
      detail={
        words.detail || checked ? (
          <span className="grid">
            {words.detail ? <span>{words.detail}</span> : null}
            {updates.enabled && checked ? (
              <span>
                <Trans>Last checked {checked}</Trans>
              </span>
            ) : null}
          </span>
        ) : null
      }
      action={
        updates.enabled ? (
          <Button
            size="small"
            variant="secondary"
            isPending={check.isPending}
            onPress={() => check.mutate()}
          >
            <Trans>Check now</Trans>
          </Button>
        ) : (
          <Link to="/admin/settings" className={linkClass}>
            <Trans>Settings</Trans>
          </Link>
        )
      }
    >
      {words.title}
    </Tile>
  );
}

/** The step-8 tiles, in the frame's order; each only when the server sent its field. */
export function OpsTiles({ s, kitTile }: { s: StatusPageData; kitTile: ReactNode }) {
  const backup = s.backup;
  return (
    <>
      {backup ? <BackupsTile backup={backup} /> : null}
      {backup ? <DrillTile backup={backup} /> : null}
      {backup ? <VerifyTile backup={backup} /> : null}
      {backup && backup.bucketVersioning !== 'not_applicable' ? (
        <VersioningTile backup={backup} />
      ) : null}
      {s.disk ? <DiskTile disk={s.disk} /> : null}
      {kitTile}
      {s.release ? <ReleaseTile release={s.release} /> : null}
      {s.jobs ? <JobsTile failed={s.jobs.failedLastDay} /> : null}
      {s.updates ? <UpdatesTile updates={s.updates} /> : null}
    </>
  );
}
