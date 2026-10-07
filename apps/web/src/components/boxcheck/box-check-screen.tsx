/**
 * The box check (D40, D175; screens §6, §8; plan T26, Q25; board frame 3). A focused task with its
 * own footer: tick what is in the box, count what is short, add what turned up from elsewhere, and
 * finish. Unticked things become *not here*; "found 2 of 3" splits the row (D10); things found
 * here from elsewhere move in; everything checked is marked seen.
 *
 * Online it is `POST /things/:id/box-check`, one undoable event (D150). Offline, or when that call
 * can't reach the server, it is one `box_check` op in the queue. Either way the summary offers
 * Undo. Service-worker updates wait while it is open (T23).
 */
import { newId, type Role } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { captureApi } from '@/api/capture/queries';
import type { BoxCheckBody, BoxCheckResult } from '@/api/capture/types';
import { isApiError } from '@/api/client';
import { inventoryApi } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import type { Detect } from '@/camera/label-recogniser';
import { appDetect } from '@/camera/scanner';
import type { CameraEnv } from '@/camera/session';
import { undoEvents } from '@/components/history/undo';
import { PlusIcon, QrIcon, XIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { ErrorState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { queueItem, resolveScan, type ScanStore } from '@/components/scan/resolve';
import { ScannerView } from '@/components/scan/scanner-view';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useHoldUpdates } from '@/pwa/register';
import { Checklist, FoundElsewhere } from './checklist';
import { type BoxData, canCheck, loadBox } from './load';

type Extra = { id: string; name: string | null; shortCode: string | null };

type Done =
  | { via: 'server'; result: BoxCheckResult }
  | {
      via: 'queue';
      key: string;
      counts: { seen: number; notHere: number; split: number; movedIn: number };
    };

/** What a check will do, counted on the phone: the summary of a queued one, and the preview. */
export function preview(
  lines: BoxData['lines'],
  found: Readonly<Record<string, number>>,
  extra: readonly Extra[],
) {
  let seen = 0;
  let notHere = 0;
  let split = 0;
  for (const l of lines) {
    const n = found[l.id] ?? 0;
    if (n >= l.quantity) seen += 1;
    else if (n === 0) notHere += 1;
    else split += 1;
  }
  return { seen, notHere, split, movedIn: extra.length };
}

export type BoxCheckScreenProps = {
  containerId: string;
  store: ScanStore | null;
  onExit: () => void;
  onQueued?: () => void;
  online?: boolean;
  camera?: CameraEnv;
  detect?: Detect | null;
};

export function BoxCheckScreen({
  containerId,
  store,
  onExit,
  onQueued,
  online: onlineProp,
  camera,
  detect,
}: BoxCheckScreenProps) {
  const { t } = useLingui();
  const fmt = useFormat();
  const errorText = useErrorText();
  const browserOnline = useOnline();
  const online = onlineProp ?? browserOnline;
  useHoldUpdates(true);

  const box = useQuery({
    queryKey: ['box-check', containerId, online, !!store],
    queryFn: () => loadBox(containerId, { store, online }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const locations = useLocations();
  const [phoneRole, setPhoneRole] = useState<Role | null>(null);
  const locationId = box.data?.container.locationId ?? null;
  useEffect(() => {
    if (!store || !locationId) return;
    void store
      .locations()
      .then((ls) => setPhoneRole(ls.find((l) => l.id === locationId)?.role ?? null));
  }, [store, locationId]);
  const role =
    (locations.data?.find((l) => l.id === locationId)?.role as Role | undefined) ?? phoneRole;

  const [found, setFound] = useState<Record<string, number>>({});
  const [extra, setExtra] = useState<Extra[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const setOne = useCallback((id: string, n: number) => setFound((f) => ({ ...f, [id]: n })), []);

  const data = box.data;
  const lines = data?.lines ?? [];
  const ticked = lines.filter((l) => (found[l.id] ?? 0) > 0).length;
  const name = data?.container.name ?? t`this box`;

  const finish = async () => {
    if (!data) return;
    setBusy(true);
    const body: BoxCheckBody = {
      id: newId(),
      lines: lines.map((l) => ({
        thingId: l.id,
        expectedQty: l.expected,
        foundQty: String(found[l.id] ?? 0),
      })),
      foundElsewhereIds: extra.map((e) => e.id),
    };
    try {
      if (online) {
        try {
          const result = await captureApi.boxCheck(containerId, body);
          setDone({ via: 'server', result });
          return;
        } catch (e) {
          if (!(isApiError(e) && e.code === 'offline')) throw e;
        }
      }
      if (!store) throw new Error('offline');
      const item = queueItem(
        'box_check',
        data.container.locationId,
        {
          id: body.id,
          containerId,
          lines: body.lines,
          foundElsewhereIds: body.foundElsewhereIds ?? [],
        },
        { key: `box:${body.id}` },
      );
      await store.enqueue(item, []);
      onQueued?.();
      setDone({ via: 'queue', key: item.idempotencyKey, counts: preview(lines, found, extra) });
    } catch (e) {
      toast({ title: t`Couldn't finish the check`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!done) return;
    try {
      if (done.via === 'server') {
        if (!done.result.undo) return;
        await undoEvents([done.result.undo.eventId]);
      } else {
        const gone = await store?.unqueue([done.key]);
        if (!gone?.length) throw new Error('sent');
      }
      toast({ title: t`Undone`, tone: 'ok' });
      setDone(null);
    } catch (e) {
      const hint = (e as { hint?: string }).hint;
      toast({
        title: t`Couldn't undo that`,
        ...(hint ? { description: hint } : {}),
        tone: 'danger',
      });
    }
  };

  const frame = (body: ReactNode, footer?: ReactNode) => (
    <div
      data-focused-task="box-check"
      className="fixed inset-0 z-40 flex flex-col bg-paper pt-[env(safe-area-inset-top)] text-ink md:relative md:inset-auto md:z-auto md:mx-auto md:my-4 md:max-w-2xl md:rounded-2xl md:border md:border-line"
    >
      <header className="flex items-center gap-2 border-b border-line bg-surface px-2 py-2 md:rounded-t-2xl">
        <AriaButton
          aria-label={t`Close box check`}
          onPress={onExit}
          className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-[10px] text-ink-2 outline-none data-focus-visible:outline-2 data-focus-visible:outline-info data-hovered:bg-sunken [&_svg]:size-6"
        >
          <XIcon />
        </AriaButton>
        <div className="grid min-w-0 flex-1">
          <h1 className="m-0 font-semibold text-title [overflow-wrap:anywhere]">
            <bdi>{name}</bdi>
          </h1>
        </div>
        {data?.container.shortCode ? <IdChip code={data.container.shortCode} /> : null}
      </header>
      <div className="grid flex-1 content-start gap-3 overflow-y-auto px-3.5 py-3 md:px-5">
        {body}
      </div>
      {footer ? (
        <div className="grid grid-cols-2 gap-2 border-t border-line bg-surface px-3 pt-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:rounded-b-2xl">
          {footer}
        </div>
      ) : null}
    </div>
  );

  if (box.isPending) return frame(<LoadingRows rows={4} label={t`Loading the box`} />);
  if (box.error) return frame(<ErrorState error={box.error} onRetry={() => void box.refetch()} />);
  if (!data)
    return frame(
      <Notice tone="info" title={<Trans>Not on this phone</Trans>}>
        <Trans>Open this box once while online, then you can check it offline too.</Trans>
      </Notice>,
    );
  if (role && !canCheck(role))
    return frame(
      <Notice tone="info">
        <Trans>Viewers can't check boxes. Ask a member or an admin of this location.</Trans>
      </Notice>,
    );

  if (done) {
    const c =
      done.via === 'server'
        ? {
            seen: done.result.seen.length,
            notHere: done.result.notHere.length,
            split: done.result.split.length,
            movedIn: done.result.movedIn.length,
          }
        : done.counts;
    const canUndo = done.via === 'queue' || !!done.result.undo;
    return frame(
      <section aria-label={t`Box check done`} className="grid gap-3" role="status">
        <h2 className="m-0 font-semibold text-[19px]">
          <Trans>Box check done</Trans>
        </h2>
        <ul className="m-0 grid list-none gap-1 p-0 text-ink-2">
          <li>{plural(c.seen, { one: '# seen', other: '# seen' })}</li>
          {c.notHere ? (
            <li>{plural(c.notHere, { one: '# not here', other: '# not here' })}</li>
          ) : null}
          {c.split ? (
            <li>
              {plural(c.split, {
                one: '# partly here: the rest is marked not here',
                other: '# partly here: the rest is marked not here',
              })}
            </li>
          ) : null}
          {c.movedIn ? (
            <li>{plural(c.movedIn, { one: '# moved in', other: '# moved in' })}</li>
          ) : null}
        </ul>
        {done.via === 'queue' ? (
          <p className="m-0 text-small text-ink-3">
            <Trans>Saved on this phone. It syncs when you're online.</Trans>
          </p>
        ) : null}
      </section>,
      <>
        {canUndo ? (
          <Button variant="secondary" onPress={() => void undo()}>
            <Trans>Undo</Trans>
          </Button>
        ) : (
          <span />
        )}
        <Button onPress={onExit}>
          <Trans>Done</Trans>
        </Button>
      </>,
    );
  }

  const total = lines.length;
  const pct = total ? Math.round((ticked / total) * 100) : 0;
  return frame(
    <>
      <div className="grid gap-2 rounded-xl border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-[12.5px] text-ink-3 uppercase tracking-[0.06em]">
            <Trans>Box check · in progress</Trans>
          </span>
          <span className="font-semibold">{t`${fmt.num(ticked)} of ${fmt.num(total)} ticked`}</span>
        </div>
        <div
          role="progressbar"
          aria-label={t`Ticked`}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={ticked}
          className="h-1.5 overflow-hidden rounded-full bg-sunken"
        >
          <i className="block h-full bg-ink" style={{ inlineSize: `${pct}%` }} />
        </div>
        <p className="m-0 text-small text-ink-2">
          <Trans>
            Unticked become <b>not here</b> when you finish.
          </Trans>
        </p>
        {data.from === 'phone' && data.asOf ? (
          <p className="m-0 text-small text-ink-3">
            {t`From this phone, as of last sync ${fmt.dateTime(data.asOf)}`}
          </p>
        ) : null}
      </div>
      {total === 0 ? (
        <p className="m-0 text-ink-2">
          <Trans>Nothing is recorded in this box. Add what you find in it.</Trans>
        </p>
      ) : (
        <Checklist lines={lines} found={found} onFound={setOne} />
      )}
      <FoundElsewhere
        items={extra}
        onRemove={(id) => setExtra((x) => x.filter((e) => e.id !== id))}
      />
      <FoundSomethingElse
        isOpen={adding}
        onClose={() => setAdding(false)}
        store={store}
        online={online}
        locationId={data.container.locationId}
        exclude={new Set([containerId, ...lines.map((l) => l.id), ...extra.map((e) => e.id)])}
        onAdd={(it) => {
          setExtra((x) => [...x, it]);
          setAdding(false);
        }}
        {...(camera ? { camera } : {})}
        detect={detect === undefined ? appDetect() : detect}
      />
    </>,
    <>
      <Button variant="secondary" onPress={() => setAdding(true)}>
        <PlusIcon className="size-5" />
        <Trans>Found something else</Trans>
      </Button>
      <Button isPending={busy} onPress={() => void finish()}>
        <Trans>Finish check</Trans>
      </Button>
    </>,
  );
}

/**
 * "Found something else" (screens §6): scan its label or search for it; it moves into the box
 * when the check is done. Only things in this box's location (a move across locations has its
 * own warning, D45).
 */
function FoundSomethingElse({
  isOpen,
  onClose,
  store,
  online,
  locationId,
  exclude,
  onAdd,
  camera,
  detect,
}: {
  isOpen: boolean;
  onClose: () => void;
  store: ScanStore | null;
  online: boolean;
  locationId: string;
  exclude: ReadonlySet<string>;
  onAdd: (it: Extra) => void;
  camera?: CameraEnv;
  detect: Detect | null;
}) {
  const { t } = useLingui();
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [local, setLocal] = useState<Extra[]>([]);
  const query = q.trim();
  const server = useQuery({
    queryKey: ['box-check', 'find', locationId, query],
    queryFn: () => inventoryApi.things({ locationId, q: query, limit: 20 }),
    enabled: isOpen && online && query.length > 0,
  });
  useEffect(() => {
    if (online || !store || !query) {
      setLocal([]);
      return;
    }
    let live = true;
    void store.search(query, 40).then((rows) => {
      if (live) setLocal(rows.filter((r) => r.locationId === locationId));
    });
    return () => {
      live = false;
    };
  }, [online, store, query, locationId]);
  const hits = (online ? (server.data?.items ?? []) : local).filter((h) => !exclude.has(h.id));

  const onRead = async (read: { text: string; format?: string }) => {
    setNote(null);
    const res = await resolveScan(read, { store, online }).catch(() => null);
    if (res?.outcome === 'open' && res.target.kind === 'thing') {
      if (exclude.has(res.target.id)) {
        setNote(t`That's already on the list.`);
        return;
      }
      if (res.target.locationId && res.target.locationId !== locationId) {
        setNote(t`That's in another location. Move it from its own page.`);
        return;
      }
      const t2 = store ? await store.thing(res.target.id) : undefined;
      let name = t2?.name ?? null;
      let shortCode = t2?.shortCode ?? res.code;
      if (!t2 && online) {
        const v = await inventoryApi.thing(res.target.id).catch(() => null);
        name = v?.name ?? null;
        shortCode = v?.shortCode ?? shortCode;
      }
      setScanning(false);
      onAdd({ id: res.target.id, name, shortCode });
      return;
    }
    setNote(t`That label isn't on a thing in your Kept.`);
  };

  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`Found something else`}>
      <div className="grid gap-3">
        <p className="m-0 text-small text-ink-3">
          <Trans>It moves into this box when you finish.</Trans>
        </p>
        {scanning ? (
          <div className="relative h-60 overflow-hidden rounded-xl bg-[#1C1A17]">
            <ScannerView
              detect={detect}
              paused={false}
              onRead={(r) => void onRead(r)}
              {...(camera ? { camera } : {})}
            />
          </div>
        ) : (
          <Button variant="secondary" onPress={() => setScanning(true)}>
            <QrIcon className="size-5" />
            <Trans>Scan its label</Trans>
          </Button>
        )}
        {note ? <Notice tone="info">{note}</Notice> : null}
        <TextField
          label={t`Or search`}
          type="search"
          value={q}
          onChange={setQ}
          placeholder={t`Name, or its code`}
        />
        {query ? (
          <ul
            aria-label={t`Results`}
            className="m-0 grid max-h-64 list-none gap-1.5 overflow-y-auto p-0"
          >
            {hits.map((h) => (
              <li key={h.id}>
                <AriaButton
                  onPress={() => onAdd({ id: h.id, name: h.name, shortCode: h.shortCode })}
                  className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2 text-start outline-none data-focus-visible:outline-2 data-focus-visible:outline-info data-hovered:bg-sunken"
                >
                  <bdi className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                    {h.name ?? t`Unnamed`}
                  </bdi>
                  <IdChip code={h.shortCode} pending={h.shortCode === null} />
                </AriaButton>
              </li>
            ))}
          </ul>
        ) : null}
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </Sheet>
  );
}
