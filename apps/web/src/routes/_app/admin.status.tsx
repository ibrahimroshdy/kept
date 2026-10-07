/**
 * Admin → Status (task 25; D193). Version, database, open alerts, mail, the recovery-kit
 * acknowledgement, which the status page keeps asking for until it's given, the nightly
 * backup (T31c, D207), which it says loudly is missing, failing or stale, and the reminder scan
 * (step 4, T14; D166), which it says loudly has stopped when no pass finished for 2 hours. Step 6
 * adds search embeddings with their source switch (T24, D207), the MCP endpoint and OAuth
 * connectors (T22, D125), and OIDC sign-in (T22, D127). Step 8 (T22): the recovery kit's tile
 * downloads it after re-authentication, and says when it changed since the last download. Step 8
 * (T21; frames 107, 108): the page reads OpsAdminStatus, and its backups, restore drill, repository
 * check, bucket versioning, disk, release, failed-jobs and update tiles (components/ops/
 * status-tiles.tsx) replace the alpha's backup line. A server whose database didn't answer sends
 * the step-1 summary alone; the page then shows what it has.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { acknowledgeRecoveryKit } from '@/api/admin';
import { useOpsStatus, useRecoveryKit } from '@/api/ops/queries';
import { keys } from '@/api/queries';
import type { AdminStatus } from '@/api/types';
import { EmbeddingsSourceSection } from '@/components/admin/embeddings-source';
import { ConnectorsStatus, OidcStatus } from '@/components/admin/oidc-status';
import { KitDownloadButton } from '@/components/ops/kit-download';
import { OpsNotices, OpsTiles, Tile } from '@/components/ops/status-tiles';
import { ErrorState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';

export const Route = createFileRoute('/_app/admin/status')({ component: StatusPage });

/**
 * D193: the acknowledgement later steps ask for before the first secret, AI key or backup
 * (409 recovery_kit_required). Kept can't check that the kit was kept; the admin says so.
 */
function AcknowledgeKit() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const ack = useMutation({
    mutationFn: acknowledgeRecoveryKit,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.admin.status }),
        qc.invalidateQueries({ queryKey: keys.me }),
      ]);
      toast({ title: t`Recovery kit noted as kept`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  return (
    <Button
      size="small"
      variant="secondary"
      isPending={ack.isPending}
      onPress={async () => {
        const ok = await confirm({
          title: t`Have you kept the recovery kit?`,
          body: t`Only say yes once the two keys from kept admin recovery-kit are stored away from this server. Kept can't check.`,
          confirmLabel: t`I've kept it`,
        });
        if (ok) ack.mutate();
      }}
    >
      <Trans>I've kept it somewhere else</Trans>
    </Button>
  );
}

/**
 * The recovery kit (D193; step 8 T9, T22): asked for until it is kept, and again when something it
 * holds changed after the last download (a rotated key, new backup settings). Downloading it after
 * re-authentication counts as keeping it; "I've kept it" stays for a kit printed on the server.
 */
function RecoveryKitNotice({ acknowledged }: { acknowledged: boolean }) {
  const kit = useRecoveryKit();
  const stale = kit.data?.stale === true;
  if (acknowledged && !stale) return null;
  if (acknowledged) {
    return (
      <Notice
        tone="warn"
        title={<Trans>The recovery kit changed since you downloaded it</Trans>}
        action={<KitDownloadButton size="small" variant="secondary" />}
      >
        <Trans>
          The key was rotated or the backup settings changed, so the kit you have can't restore
          everything. Download it again and replace the old one.
        </Trans>
      </Notice>
    );
  }
  return (
    <Notice
      tone="warn"
      title={<Trans>Keep the recovery kit somewhere else</Trans>}
      action={
        <div className="flex flex-wrap gap-2">
          <KitDownloadButton size="small" variant="secondary" />
          <AcknowledgeKit />
        </div>
      }
    >
      <Trans>
        Kept encrypts secret fields, AI keys and the backup password with KEPT_SECRET_KEY. If this
        server and its key are lost together, a backup still restores your things, but not those.
        Download the recovery kit (or print it with{' '}
        <code className="ltr whitespace-nowrap">kept admin recovery-kit</code>) and keep it away
        from this server. Kept asks for this before the first secret, AI key or backup.
      </Trans>
    </Notice>
  );
}

function RecoveryKitTile({ acknowledged }: { acknowledged: boolean }) {
  const f = useFormat();
  const kit = useRecoveryKit();
  const downloadedAt = kit.data?.downloadedAt ?? null;
  const stale = kit.data?.stale === true;
  const day = downloadedAt ? f.day(downloadedAt) : null;
  return (
    <Tile label={<Trans>Recovery kit</Trans>} ok={acknowledged && !stale}>
      <span className="grid gap-1.5">
        <span>
          {stale ? (
            <Trans>Changed since you downloaded it</Trans>
          ) : day ? (
            <Trans>Downloaded {day}</Trans>
          ) : acknowledged ? (
            <Trans>Kept safe</Trans>
          ) : (
            <Trans>Not downloaded yet</Trans>
          )}
        </span>
        <KitDownloadButton size="small" variant="secondary" className="justify-self-start">
          {stale || day ? <Trans>Download again</Trans> : undefined}
        </KitDownloadButton>
      </span>
    </Tile>
  );
}

/** No finished reminder scan for this long: reminders have stopped (server reminders/status.ts). */
const SCAN_STALE_MS = 2 * 3_600_000;

type Reminders = NonNullable<AdminStatus['reminders']>;

const scanStopped = (r: Reminders | null) =>
  !r?.lastOkAt || Date.now() - new Date(r.lastOkAt).getTime() > SCAN_STALE_MS;

function RemindersNotice({ reminders }: { reminders: Reminders | null }) {
  const f = useFormat();
  if (!scanStopped(reminders)) return null;
  const lastOk = reminders?.lastOkAt ? f.dateTime(reminders.lastOkAt) : null;
  return (
    <Notice tone="warn" title={<Trans>Reminders have stopped going out</Trans>}>
      {lastOk ? (
        <Trans>
          Kept last checked for due reminders {lastOk}. Until it checks again, nobody gets new
          reminders.
        </Trans>
      ) : (
        <Trans>No check for due reminders has finished yet, so nobody gets reminders.</Trans>
      )}{' '}
      <Trans>
        Failed jobs shows why it stopped; if the worker isn't running, start it again. The next good
        check resolves this alert.
      </Trans>
    </Notice>
  );
}

function RemindersTile({ reminders }: { reminders: Reminders | null }) {
  const f = useFormat();
  const at = reminders?.lastOkAt ? f.relative(reminders.lastOkAt) : null;
  const n = f.num(reminders?.occurrences ?? 0);
  return (
    <Tile label={<Trans>Reminders</Trans>} ok={!scanStopped(reminders)}>
      {at ? (
        <Trans>
          Checked {at} · {n} new
        </Trans>
      ) : (
        <Trans>Not checked yet</Trans>
      )}
    </Tile>
  );
}

function StatusPage() {
  const status = useOpsStatus();
  const f = useFormat();
  if (status.isPending) return <LoadingRows rows={2} />;
  if (status.error)
    return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  const s = status.data;
  const alerts = f.num(s.alerts);
  return (
    <div className="grid gap-4">
      {s.mail.configured ? null : (
        <Notice tone="warn" title={<Trans>Mail isn't configured</Trans>}>
          <Trans>
            Kept sends no email: no sign-in links, password resets, email invites or alerts. Set{' '}
            <code className="ltr whitespace-nowrap">KEPT_SMTP_URL</code> and restart Kept. Link
            invites and passwords work without it.
          </Trans>
        </Notice>
      )}
      <OpsNotices s={s} />
      {s.reminders !== undefined ? <RemindersNotice reminders={s.reminders} /> : null}
      <RecoveryKitNotice acknowledged={s.recoveryKitAcknowledged} />
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {s.release ? null : (
          <Tile label={<Trans>Version</Trans>} ok={null}>
            <span className="ltr">{s.version}</span>
          </Tile>
        )}
        <Tile label={<Trans>Database</Trans>} ok={s.dbOk}>
          {s.dbOk ? <Trans>Answering</Trans> : <Trans>Not answering</Trans>}
        </Tile>
        <Tile label={<Trans>Alerts</Trans>} ok={s.alerts === 0}>
          {s.alerts === 0 ? (
            <Trans>None open</Trans>
          ) : (
            <Link to="/admin/alerts" className="underline underline-offset-2">
              <Trans>{alerts} open</Trans>
            </Link>
          )}
        </Tile>
        <Tile label={<Trans>Mail</Trans>} ok={s.mail.configured}>
          {s.mail.configured ? <Trans>Sending</Trans> : <Trans>Not configured</Trans>}
        </Tile>
        <OpsTiles s={s} kitTile={<RecoveryKitTile acknowledged={s.recoveryKitAcknowledged} />} />
        {s.reminders !== undefined ? <RemindersTile reminders={s.reminders} /> : null}
      </div>
      {s.embeddings ? <EmbeddingsSourceSection embeddings={s.embeddings} /> : null}
      {s.connectors ? <ConnectorsStatus connectors={s.connectors} /> : null}
      {s.oidc ? <OidcStatus oidc={s.oidc} /> : null}
    </div>
  );
}
