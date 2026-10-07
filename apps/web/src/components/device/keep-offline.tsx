/**
 * This device → Keep available offline (step-8 plan T23; D159, D181, Q21; board frame 110): one
 * switch per location, only with the app lock on. Turning one on shows the warning and the size
 * from the server's estimate before anything downloads, then the progress; documents over
 * KEEP_OFFLINE.fileBytes are listed as too large; the device's total is capped at
 * KEEP_OFFLINE.deviceBytes (`keep_offline_too_large` names what to turn off). Off removes it.
 */
import { KEEP_OFFLINE } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { inventoryApi } from '@/api/inventory/queries';
import { opsApi, useSyncExtrasEstimate } from '@/api/ops/queries';
import type { LocationSummary } from '@/api/types';
import { List, Notice } from '@/components/page';
import { useFileSize } from '@/components/portability/size';
import { useRoleLabels } from '@/components/things/labels';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import type { KeptOfflineRow } from '@/offline/db';
import type { ExtrasApi, KeepProgress, KeptDocument } from '@/offline/extras';
import { useAppLock } from './app-lock';
import { PinSheet } from './pin-sheet';

const api: ExtrasApi = {
  page: (locationId, cursor) => opsApi.syncExtras(locationId, cursor),
  estimate: (locationId) => opsApi.syncExtrasEstimate(locationId),
  fileUrl: (fileId, thingId) => inventoryApi.fileUrl(fileId, 'original', thingId),
};

export function KeepOffline({
  locations,
  kept,
  reload,
}: {
  locations: LocationSummary[];
  kept: KeptOfflineRow[];
  reload: () => Promise<void>;
}) {
  const lock = useAppLock();
  const size = useFileSize();
  const lockOn = !!lock?.record;
  const total = kept.reduce((n, r) => n + r.bytes, 0);
  const share = Math.min(100, (total / KEEP_OFFLINE.deviceBytes) * 100);
  return (
    <div className="grid gap-3">
      <Notice tone="warn" title={<Trans>If this phone is lost</Trans>}>
        <Trans>
          Whoever unlocks Kept sees prices and documents for these locations. The PIN keeps out
          someone holding the phone, not someone who has copied the browser’s storage.
        </Trans>
      </Notice>
      {!lockOn ? (
        <Notice tone="info">
          <Trans>Turn on the app lock first: what you keep offline is locked behind it.</Trans>
        </Notice>
      ) : null}
      <List>
        {locations.map((loc) => (
          <li key={loc.id}>
            <KeepRow
              location={loc}
              row={kept.find((r) => r.locationId === loc.id) ?? null}
              names={(id) => locations.find((l) => l.id === id)?.name ?? ''}
              reload={reload}
            />
          </li>
        ))}
      </List>
      <div className="grid gap-1">
        {/* The bar draws the line below it, which says the same in words. */}
        <div className="h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
          <i className="block h-full bg-ink-2" style={{ inlineSize: `${share}%` }} />
        </div>
        <span className="text-small text-ink-2">
          <Trans>
            {size(total)} of {size(KEEP_OFFLINE.deviceBytes)} on this device
          </Trans>
        </span>
      </div>
    </div>
  );
}

function KeepRow({
  location,
  row,
  names,
  reload,
}: {
  location: LocationSummary;
  row: KeptOfflineRow | null;
  names: (id: string) => string;
  reload: () => Promise<void>;
}) {
  const lock = useAppLock();
  const { t } = useLingui();
  const f = useFormat();
  const size = useFileSize();
  const roles = useRoleLabels();
  const confirm = useConfirm();
  const online = useOnline();
  const lockOn = !!lock?.record;
  const [progress, setProgress] = useState<KeepProgress | null>(null);
  const [askPin, setAskPin] = useState(false);
  const [tooLarge, setTooLarge] = useState<KeptDocument[]>([]);
  const estimate = useSyncExtrasEstimate(lockOn && online && !row ? location.id : null);
  const busy = progress !== null;
  const db = lock?.db ?? null;
  const key = lock?.dataKey ?? null;

  useEffect(() => {
    if (!db || !key || !row || row.tooLarge === 0) {
      setTooLarge([]);
      return;
    }
    let live = true;
    void import('@/offline/extras')
      .then((m) => m.tooLargeOf(db, key, location.id))
      .then((docs) => {
        if (live) setTooLarge(docs);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [db, key, row, location.id]);

  const keep = async () => {
    if (!db || !key) {
      setAskPin(true);
      return;
    }
    setProgress({ done: 0, total: 0 });
    try {
      const m = await import('@/offline/extras');
      await m.keepLocation(db, key, location.id, api, setProgress);
      toast({ title: t`${location.name} is kept offline on this device`, tone: 'ok' });
    } catch (e) {
      const m = await import('@/offline/extras');
      if (e instanceof m.KeepOfflineTooLarge) {
        const list = e.kept.map((k) => `${names(k.locationId)} (${size(k.bytes)})`).join(f.sep);
        toast({
          title: t`That is more than this device can keep offline.`,
          description: list ? t`Turn off one of these first: ${list}` : undefined,
          tone: 'danger',
        });
      } else {
        toast({ title: t`Keeping ${location.name} offline didn’t finish`, tone: 'danger' });
      }
    } finally {
      setProgress(null);
      await reload();
    }
  };

  const onToggle = async (on: boolean) => {
    if (!db) return;
    if (!on) {
      const m = await import('@/offline/extras');
      await m.dropLocation(db, location.id);
      await reload();
      return;
    }
    const about = estimate.data;
    const ok = await confirm({
      title: t`Keep ${location.name} available offline?`,
      body: about
        ? t`Whoever unlocks Kept on this phone sees prices and documents for this location. About ${size(about.totalBytes)} to download.`
        : t`Whoever unlocks Kept on this phone sees prices and documents for this location.`,
      confirmLabel: t`Keep offline`,
    });
    if (ok) await keep();
  };

  let detail: string | null = null;
  if (progress) {
    detail = t`Downloading ${size(progress.done)} of ${size(progress.total)}`;
  } else if (row?.state === 'failed') {
    detail = t`Didn’t finish. Update to try again.`;
  } else if (row) {
    const parts = [
      plural(row.things, { one: '# thing', other: '# things' }),
      plural(row.documents, { one: '# document', other: '# documents' }),
      size(row.bytes),
    ];
    if (row.updatedAt) {
      parts.push(t`updated ${f.relative(new Date(row.updatedAt).toISOString())}`);
    }
    detail = parts.join(f.sep);
  } else if (lockOn && estimate.data) {
    detail = t`About ${size(estimate.data.totalBytes)} to download`;
  }

  const large =
    tooLarge.length > 0
      ? `${plural(tooLarge.length, {
          one: '# document is too large to keep offline:',
          other: '# documents are too large to keep offline:',
        })} ${tooLarge.map((d) => `${d.title ?? roles[d.kind]} (${size(d.bytes)})`).join(f.sep)}`
      : row && row.tooLarge > 0
        ? plural(row.tooLarge, {
            one: '# document is too large to keep offline.',
            other: '# documents are too large to keep offline.',
          })
        : null;

  return (
    <div className="flex items-start gap-3 px-3.5 py-3">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="font-semibold text-[15px] [overflow-wrap:anywhere]">
          <bdi>{location.name}</bdi>
        </div>
        {detail ? (
          <div className="text-small text-ink-2 [overflow-wrap:anywhere]">{detail}</div>
        ) : null}
        {large ? (
          <div className="text-small text-ink-2 [overflow-wrap:anywhere]">{large}</div>
        ) : null}
        {row && !busy && online ? (
          <div className="pt-1">
            <Button size="small" variant="secondary" onPress={() => void keep()}>
              <Trans>Update</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      <Switch
        aria-label={t`Keep ${location.name} available offline`}
        isSelected={row !== null || busy}
        isDisabled={!lockOn || busy || (!row && !online)}
        onChange={(on) => void onToggle(on)}
      />
      {askPin ? (
        <PinSheet
          title={<Trans>Enter your PIN</Trans>}
          steps={[
            {
              prompt: <Trans>Kept offline is locked behind your PIN.</Trans>,
              length: lock?.record?.pinLength,
            },
          ]}
          onClose={() => setAskPin(false)}
          onDone={async ([pin]) => {
            const result = (await lock?.openExtras(pin as string)) ?? 'wrong';
            if (result === 'ok') {
              setAskPin(false);
              return null;
            }
            return result === 'wiped' ? null : t`Wrong PIN.`;
          }}
        />
      ) : null}
    </div>
  );
}
