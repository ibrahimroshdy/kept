/**
 * A claim pack (D158, D180; plan T26 and Q19, `/reports/claim-pack`): a ZIP with the insurance
 * report and every receipt, invoice, photo and serial for an incident (`?incident=`) or a
 * selection of things in a location (`?loc=&things=a,b`), shared by an expiring download link.
 *
 * - It is the one link that carries prices and documents (D116), so it starts with the warning
 *   "This includes prices and documents" and a tick box that must be ticked (the server refuses
 *   a pack without the acknowledgement).
 * - Then the pack's progress, polled, until it's ready.
 * - **Create link** (1 to 7 days): the link is shown **once**, with Copy and Share; after that the
 *   page shows only its expiry, how many times it was downloaded and when last, with Revoke and
 *   New link (which revokes the old one). Kept never sends it anywhere.
 * - **Download** for you: a plain download where downloads work; on the installed iPhone app the
 *   ZIP is fetched first and then offered on the share sheet with a second press (lib/files.ts),
 *   since iOS does nothing with an attachment link there. Downloading counts on the link, as any.
 *
 * Owners and admins only (`incidents.manage`), online only. `?run=` resumes a pack (the "ready"
 * notification's link); only its creator can read it.
 */
import { can } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { ProgressBar } from 'react-aria-components';
import { ApiError } from '@/api/client';
import { householdApi, householdKeys, useClaimPack, useIncident } from '@/api/household/queries';
import type { ClaimPack, ClaimPackLink, CreateClaimPackBody } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import { AlertIcon, DocumentIcon, ShareIcon } from '@/components/icons';
import { TickBox } from '@/components/incidents/incident-sheet';
import { useIncidentName } from '@/components/incidents/labels';
import { EmptyState, LoadingRows, Notice, Page, useErrorText } from '@/components/page';
import { Button, buttonClass } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { CopyButton } from '@/components/ui/copy-button';
import { Select, SelectItem } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { canShareFiles, downloadsWork, shareFiles } from '@/lib/files';
import { sep, useBytes, useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { usePrefs } from '@/lib/prefs';
import type { ReportSearch } from './insurance-report';

/** At most this many things in a selection's pack (the server's limit). */
const MAX_THINGS = 500;
const POLL_MS = 1000;

/** The ZIP, fetched through the link, as a file to share (the installed iPhone app). */
async function fetchZip(url: string, day: string): Promise<File> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit' });
  } catch {
    throw new ApiError(0, 'offline', 'Needs a connection');
  }
  if (!res.ok)
    throw new ApiError(
      res.status,
      res.status === 410 ? 'link_expired' : 'internal',
      res.statusText,
    );
  return new File([await res.blob()], `kept-claim-${day}.zip`, { type: 'application/zip' });
}

export function ClaimPackScreen({ search }: { search: ReportSearch }) {
  const { t } = useLingui();
  const locations = useLocations();
  const incident = useIncident(search.incident ?? '');
  const nameIncident = useIncidentName();
  const locationName = useLocationName();
  const all = locations.data ?? [];
  const things = (search.things ?? '').split(',').filter(Boolean);

  if (locations.isPending || (search.incident && incident.isPending))
    return (
      <Page title={t`Claim pack`}>
        <LoadingRows rows={3} />
      </Page>
    );

  if (search.run)
    return (
      <Page title={t`Claim pack`}>
        <PackProgress id={search.run} />
      </Page>
    );

  const locationId = search.incident ? incident.data?.locationId : search.loc;
  const location = all.find((l) => l.id === locationId);
  const scope: CreateClaimPackBody['scope'] | null = search.incident
    ? incident.data
      ? { incidentId: incident.data.id }
      : null
    : location && things.length
      ? { locationId: location.id, thingIds: things.slice(0, MAX_THINGS) }
      : null;
  const back = incident.data
    ? { back: { to: '/incidents/$id' as const, params: { id: incident.data.id } } }
    : location
      ? { back: { to: '/loc/$id' as const, params: { id: location.id } } }
      : {};

  if (!scope || !location)
    return (
      <Page title={t`Claim pack`}>
        <EmptyState icon={<DocumentIcon />} title={<Trans>Choose what goes in it</Trans>}>
          <Trans>
            Make a claim pack from an incident's page, or select things in a location's list and
            choose Claim pack.
          </Trans>
        </EmptyState>
      </Page>
    );
  if (!can(location.role, 'incidents.manage'))
    return (
      <Page title={t`Claim pack`} {...back}>
        <EmptyState icon={<DocumentIcon />} title={<Trans>Only an owner or admin makes one</Trans>}>
          <Trans>
            A claim pack carries prices and documents, so only owners and admins make it.
          </Trans>
        </EmptyState>
      </Page>
    );

  const where = locationName(location);
  const what = incident.data
    ? nameIncident(incident.data)
    : plural(things.length, { one: `# thing in ${where}`, other: `# things in ${where}` });
  return (
    <Page title={t`Claim pack`} {...back}>
      <StartPack scope={scope} what={what} />
    </Page>
  );
}

function StartPack({ scope, what }: { scope: CreateClaimPackBody['scope']; what: string }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const online = useOnline();
  const prefs = usePrefs();
  const [acknowledged, setAcknowledged] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!acknowledged) return;
    setBusy(true);
    setFailed(null);
    try {
      const created = await householdApi.createClaimPack({
        scope,
        locale: prefs.locale,
        digits: prefs.digits,
        acknowledged: true,
      });
      setId(created.id);
    } catch (err) {
      setFailed(err);
    } finally {
      setBusy(false);
    }
  };

  if (id) return <PackProgress id={id} />;
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      <p className="m-0">
        <Trans>
          For <span className="font-medium">{what}</span>
        </Trans>
      </p>
      <p className="m-0 text-ink-2">
        <Trans>
          A ZIP for your insurer: the insurance report, every receipt and invoice as you uploaded
          it, the photos, and a list of serial numbers. You share it with a link that expires.
        </Trans>
      </p>
      <Notice tone="warn" title={t`This includes prices and documents`}>
        <Trans>
          Anyone with the link can download what you paid, your receipts and the serial numbers,
          without signing in, until it expires or you revoke it. Passwords and codes are never in
          it.
        </Trans>
      </Notice>
      <TickBox isSelected={acknowledged} onChange={setAcknowledged}>
        <Trans>I understand the link shares prices and documents</Trans>
      </TickBox>
      {failed ? <Notice tone="danger">{errorText(failed)}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" isPending={busy} isDisabled={!online || !acknowledged}>
          <DocumentIcon className="size-4" />
          <Trans>Make the claim pack</Trans>
        </Button>
        {online ? null : (
          <span className="text-small text-ink-3">
            <Trans>Needs a connection</Trans>
          </span>
        )}
      </div>
    </form>
  );
}

function PackProgress({ id }: { id: string }) {
  const { t } = useLingui();
  const f = useFormat();
  const errorText = useErrorText();
  const [polling, setPolling] = useState(true);
  const query = useClaimPack(id, polling ? POLL_MS : false);
  const pack = query.data;
  const settled =
    !!pack && (pack.status === 'done' || pack.status === 'failed' || pack.status === 'expired');
  useEffect(() => {
    if (settled) setPolling(false);
  }, [settled]);

  if (query.error)
    return (
      <Notice tone="danger" title={<Trans>Couldn't check on the claim pack</Trans>}>
        {errorText(query.error)}
      </Notice>
    );
  if (!pack || pack.status === 'queued')
    return (
      <ProgressBar aria-label={t`Making the claim pack`} isIndeterminate className="grid gap-1.5">
        <span className="text-small text-ink-2">
          <Trans>Waiting to start…</Trans>
        </span>
        <span className="h-1.5 overflow-hidden rounded-full bg-sunken">
          <span className="block h-full w-1/3 animate-pulse bg-amber" />
        </span>
      </ProgressBar>
    );
  if (pack.status === 'running') {
    const done = f.num(pack.progress.done);
    const total = f.num(pack.progress.total);
    return (
      <ProgressBar
        aria-label={t`Making the claim pack`}
        value={pack.progress.done}
        maxValue={Math.max(1, pack.progress.total)}
        valueLabel={t`${done} of ${total}`}
        className="grid gap-1.5"
      >
        {({ percentage, valueText }) => (
          <>
            <span className="flex justify-between gap-3 text-small text-ink-2">
              <Trans>Gathering the files…</Trans>
              <span className="tabular-nums">{valueText}</span>
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-sunken">
              <span
                className="block h-full bg-amber transition-[width]"
                style={{ width: `${percentage ?? 0}%` }}
              />
            </span>
          </>
        )}
      </ProgressBar>
    );
  }
  if (pack.status === 'done') return <PackReady pack={pack} />;
  return (
    <Notice
      tone={pack.status === 'expired' ? 'warn' : 'danger'}
      title={
        pack.status === 'expired' ? (
          <Trans>This claim pack has expired</Trans>
        ) : (
          <Trans>Couldn't make the claim pack</Trans>
        )
      }
    >
      {pack.status === 'expired' ? (
        <Trans>It's kept for 7 days. Make a new one from the incident or the selection.</Trans>
      ) : (
        <Trans>Something went wrong on the server. Try again.</Trans>
      )}
    </Notice>
  );
}

function PackReady({ pack }: { pack: ClaimPack }) {
  const { t } = useLingui();
  const f = useFormat();
  const bytes = useBytes();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const online = useOnline();
  const [days, setDays] = useState(7);
  // The link, only in the moment it's made: the server never shows it again.
  const [fresh, setFresh] = useState<ClaimPackLink | null>(null);
  const [busy, setBusy] = useState<'link' | 'revoke' | 'zip' | null>(null);
  const [zip, setZip] = useState<File | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: householdKeys.claimPack(pack.id) });
  const keptUntil = f.day(pack.expiresAt);

  const makeLink = async () => {
    setBusy('link');
    try {
      const link = await householdApi.createClaimPackLink(pack.id, { days });
      setFresh(link);
      setZip(null);
      await refresh();
    } catch (err) {
      toast({ tone: 'danger', title: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  const revoke = async () => {
    const ok = await confirm({
      title: t`Revoke the link?`,
      body: t`It stops working at once, for everyone who has it. You can make a new one.`,
      confirmLabel: t`Revoke`,
      destructive: true,
    });
    if (!ok) return;
    setBusy('revoke');
    try {
      await householdApi.revokeClaimPackLink(pack.id);
      setFresh(null);
      setZip(null);
      await refresh();
      toast({ tone: 'ok', title: t`Link revoked` });
    } catch (err) {
      toast({ tone: 'danger', title: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  const getZip = async (url: string) => {
    setBusy('zip');
    try {
      setZip(await fetchZip(url, new Date().toISOString().slice(0, 10)));
    } catch (err) {
      toast({ tone: 'danger', title: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  const shareZip = async (file: File) => {
    const how = await shareFiles([file]);
    if (how === 'shared') setZip(null);
    if (how === 'refused') toast({ tone: 'danger', title: t`Couldn't share the file. Try again.` });
  };
  const shareLink = async (url: string) => {
    try {
      await navigator.share({ url, title: t`Claim pack` });
    } catch {
      // Closed or refused: Copy is right beside it.
    }
  };
  const canShareLink = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const link = pack.link;
  const size = pack.bytes !== undefined ? bytes(pack.bytes) : null;
  const linkExpires = link ? f.day(link.expiresAt) : '';
  const lastDownload = link?.lastDownloadedAt ? f.relative(link.lastDownloadedAt) : null;

  return (
    <div className="grid gap-4">
      <Notice tone="ok" title={<Trans>Your claim pack is ready</Trans>}>
        {size ? (
          <Trans>
            {size}, kept until {keptUntil}.
          </Trans>
        ) : (
          <Trans>Kept until {keptUntil}.</Trans>
        )}
      </Notice>

      {fresh ? (
        <section
          aria-labelledby="claim-link"
          className="grid gap-2 rounded-[10px] border border-line bg-surface p-3.5"
        >
          <h2 id="claim-link" className="m-0 font-semibold text-[15px]">
            <Trans>Your link</Trans>
          </h2>
          <p className="m-0 text-small text-ink-2">
            <Trans>Copy it now: Kept shows it only this once.</Trans>
          </p>
          <p
            dir="ltr"
            className="m-0 rounded-md bg-sunken px-2.5 py-2 font-mono text-[14px] [overflow-wrap:anywhere]"
          >
            {fresh.url}
          </p>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={fresh.url} label={t`Copy link`} size="small" />
            {canShareLink ? (
              <Button size="small" variant="secondary" onPress={() => void shareLink(fresh.url)}>
                <ShareIcon className="size-4" />
                <Trans>Share</Trans>
              </Button>
            ) : null}
            {downloadsWork() ? (
              <a href={fresh.url} rel="noopener" className={buttonClass('secondary', 'small')}>
                <Trans>Download</Trans>
              </a>
            ) : zip ? (
              canShareFiles([zip]) ? (
                <Button size="small" variant="secondary" onPress={() => void shareZip(zip)}>
                  <ShareIcon className="size-4" />
                  <Trans>Share the ZIP</Trans>
                </Button>
              ) : (
                <span className="self-center text-small text-ink-2">
                  <Trans>
                    This browser can't save files here. Open Kept in Safari to download it.
                  </Trans>
                </span>
              )
            ) : (
              <Button
                size="small"
                variant="secondary"
                isPending={busy === 'zip'}
                onPress={() => void getZip(fresh.url)}
              >
                <Trans>Get the ZIP</Trans>
              </Button>
            )}
          </div>
        </section>
      ) : null}

      {link ? (
        <div className="grid gap-1 text-small text-ink-2">
          <span>
            <Trans>Link expires {linkExpires}</Trans>
          </span>
          <span>
            {link.downloads === 0
              ? t`Not downloaded yet`
              : plural(link.downloads, { one: 'Downloaded # time', other: 'Downloaded # times' })}
            {lastDownload ? (
              <>
                {sep()}
                <Trans>last {lastDownload}</Trans>
              </>
            ) : null}
          </span>
        </div>
      ) : (
        <p className="m-0 text-small text-ink-2">
          <Trans>No link yet. Nobody can download it until you make one.</Trans>
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Select<{ id: string; name: string }>
          label={t`Link lasts`}
          items={[1, 2, 3, 5, 7].map((d) => ({
            id: String(d),
            name: plural(d, { one: '# day', other: '# days' }),
          }))}
          value={String(days)}
          onChange={(key) => key != null && setDays(Number(key))}
          className="min-w-32"
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              {item.name}
            </SelectItem>
          )}
        </Select>
        <Button isPending={busy === 'link'} isDisabled={!online} onPress={() => void makeLink()}>
          {link ? <Trans>New link</Trans> : <Trans>Create link</Trans>}
        </Button>
        {link ? (
          <Button
            variant="secondary"
            isPending={busy === 'revoke'}
            isDisabled={!online}
            onPress={() => void revoke()}
          >
            <Trans>Revoke</Trans>
          </Button>
        ) : null}
      </div>
      {link ? (
        <p className="m-0 flex items-start gap-2 text-small text-ink-2">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          <Trans>A new link stops the old one working.</Trans>
        </p>
      ) : null}
      {online ? null : (
        <span className="text-small text-ink-3">
          <Trans>Needs a connection</Trans>
        </span>
      )}
    </div>
  );
}
