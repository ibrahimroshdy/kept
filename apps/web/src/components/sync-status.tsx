/**
 * The sync status line (plan T24; D36, D148, D188, Q30, V11): what the phone's queue and copy
 * are doing, in one quiet line that appears only when there is something to say.
 *
 * - "Offline · 12 waiting to sync", or "Offline · as of last sync, 14:02" (D188). The queue holds
 *   more than captures (a label claim, a move, "seen"), so it never says "captures" (T28);
 * - on iOS, "Open to finish syncing (12)": the queue moves only while Kept is open (D36);
 * - "Update Kept to finish syncing" / "…ask your admin" when the server refused the queue (D148);
 * - a full phone, a partial copy (Q30), and a denied persistent-storage request (V11);
 * - "A change couldn't apply: the drill was trashed by Alfred" for each drop whose answer names
 *   what changed (D35, T14's `result.notice`; engineering spec's "Sync item dropped"), with Restore
 *   (the inbox's dropped changes, where the op can be applied again) and × to dismiss it;
 * - "2 changes need a look", to the inbox, for the other drops and reviews (D35).
 *
 * A polite live region says "12 waiting to sync" when the queue grows (screens §4); the capture
 * screen says "Captured." itself, for its own shutter.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { AlertIcon, InfoIcon, XIcon } from '@/components/icons';
import { Pill, type PillTone } from '@/components/page';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { asOfTime } from '@/offline/as-of';
import { useOffline, useSyncStatus } from '@/offline/provider';
import type { SyncNotice } from '@/offline/store';

/** Notices spelled out one by one; more than this and the rest are counted. */
const SHOWN_NOTICES = 3;

/** "A change couldn't apply: the drill was trashed by Alfred" (D35). */
function ChangeNotice({ notice, onDismiss }: { notice: SyncNotice; onDismiss: () => void }) {
  const { t } = useLingui();
  const n = notice.result?.notice;
  if (!n) return null;
  const name = n.name;
  const by = n.by.displayName;
  const text =
    n.action === 'trashed' ? (
      <Trans>
        A change couldn't apply: <bdi>{name}</bdi> was trashed by <bdi>{by}</bdi>.
      </Trans>
    ) : n.action === 'moved' ? (
      <Trans>
        A change couldn't apply: <bdi>{name}</bdi> was moved by <bdi>{by}</bdi>.
      </Trans>
    ) : (
      <Trans>
        A change couldn't apply: <bdi>{name}</bdi> was removed by <bdi>{by}</bdi>.
      </Trans>
    );
  return (
    <Pill tone="warn" icon={<AlertIcon />} className="max-w-full rounded-[12px]">
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {text}{' '}
        <Link
          to="/inbox"
          search={{ 'f.kind': 'sync_drop' }}
          className="font-semibold underline underline-offset-2"
        >
          {t`Restore`}
        </Link>
      </span>
      <AriaButton
        aria-label={t`Dismiss`}
        onPress={onDismiss}
        className="-me-1 grid size-7 shrink-0 place-items-center rounded-full outline-none hover:bg-sunken data-focus-visible:outline-2 data-focus-visible:outline-info [&_svg]:size-3.5"
      >
        <XIcon aria-hidden="true" />
      </AriaButton>
    </Pill>
  );
}

/** iPhone, iPad, and an iPad that says it is a Mac (it has touch). */
function appleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

export function SyncStatus() {
  const { t } = useLingui();
  const status = useSyncStatus();
  const offline = useOffline();
  const { locale, digits } = usePrefs();
  const [announcement, setAnnouncement] = useState('');
  const lastWaiting = useRef<number | null>(null);

  const waiting = status ? status.counts.waiting + status.counts.uploading : 0;
  const queue = plural(waiting, { one: '# waiting to sync', other: '# waiting to sync' });
  useEffect(() => {
    if (lastWaiting.current !== null && waiting > lastWaiting.current) setAnnouncement(queue);
    // Synced: nothing left to say.
    if (waiting === 0) setAnnouncement('');
    lastWaiting.current = waiting;
  }, [waiting, queue]);

  const lines: { key: string; tone: PillTone; text: ReactNode }[] = [];
  const notices: SyncNotice[] = [];
  if (status) {
    const time = status.asOf ? asOfTime(status.asOf, formatLocale(locale, digits)) : null;
    if (status.problem === 'client_outdated')
      lines.push({ key: 'outdated', tone: 'warn', text: t`Update Kept to finish syncing.` });
    else if (status.problem === 'server_outdated')
      lines.push({
        key: 'outdated',
        tone: 'warn',
        text: t`Kept on the server is older than this app; ask your admin.`,
      });
    else if (status.problem === 'storage_full')
      lines.push({
        key: 'full',
        tone: 'danger',
        text: t`This phone is out of space for Kept. Free some space to keep capturing offline.`,
      });
    if (status.problem === 'offline')
      lines.push({
        key: 'offline',
        tone: 'neutral',
        text:
          waiting > 0
            ? t`Offline · ${queue}`
            : time
              ? t`Offline · as of last sync, ${time}`
              : t`Offline`,
      });
    else if (waiting > 0 && appleMobile())
      lines.push({ key: 'open', tone: 'info', text: t`Open to finish syncing (${waiting})` });
    notices.push(...status.notices.slice(0, SHOWN_NOTICES));
    const unexplained = status.counts.needsAttention - notices.length;
    if (unexplained > 0)
      lines.push({
        key: 'attention',
        tone: 'warn',
        text: (
          <Link to="/inbox" className="underline underline-offset-2">
            {plural(unexplained, {
              one: '# change needs a look',
              other: '# changes need a look',
            })}
          </Link>
        ),
      });
    if (status.truncated)
      lines.push({
        key: 'truncated',
        tone: 'neutral',
        text: t`Only part of your Kept is on this phone.`,
      });
    if (status.persisted === false && waiting > 0)
      lines.push({
        key: 'persist',
        tone: 'neutral',
        text: t`This browser may clear Kept's offline copy after weeks unused. Open Kept to sync soon.`,
      });
  }

  // No store (still loading, or no IndexedDB): online-only, nothing to say or announce.
  if (!status) return null;
  return (
    <>
      {lines.length + notices.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3 md:px-6" data-testid="sync-status">
          {notices.map((n) => (
            <ChangeNotice
              key={n.id}
              notice={n}
              onDismiss={() => void offline?.engine.dismissNotice(n.id)}
            />
          ))}
          {lines.map((l) => (
            <Pill
              key={l.key}
              tone={l.tone}
              icon={l.tone === 'neutral' || l.tone === 'info' ? <InfoIcon /> : <AlertIcon />}
            >
              {l.text}
            </Pill>
          ))}
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
