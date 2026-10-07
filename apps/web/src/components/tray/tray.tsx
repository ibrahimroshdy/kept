/**
 * The carrying tray (D175, screens §6; board frames 7a–7c): pick things up from a thing's menu or
 * by scanning them, then scan the destination's label or choose a place, and everything moves in
 * one go, with Undo. The tray stays with you, offline too (it lives in the phone's store).
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useState } from 'react';
import { useOfferUndo } from '@/components/history/undo';
import { QrIcon, XIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { Notice, useErrorText } from '@/components/page';
import { MoveThingsDialog, type PickedPlace } from '@/components/places/move-picker';
import { type Described, describeTarget } from '@/components/scan/describe';
import { unsyncedCaptures } from '@/components/scan/resolve';
import { WherePicker } from '@/components/scan/where-picker';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type { OfflineStore } from '@/offline/store';
import { type Destination, type Moved, moveCarried } from './move';
import { useTray } from './use-tray';

/** The carried things, named from the phone (or the server when it doesn't have them). */
export function useCarried(store: OfflineStore | null, online: boolean) {
  const tray = useTray(store);
  const [items, setItems] = useState<(Described | { id: string; missing: true })[] | null>(null);
  const ids = tray.ids;
  useEffect(() => {
    if (!ids) return;
    let live = true;
    void Promise.all(
      ids.map(
        async (id) =>
          (await describeTarget({ kind: 'thing', id, locationId: '' }, { store, online })) ?? {
            id,
            missing: true as const,
          },
      ),
    ).then((rows) => {
      if (live) setItems(rows);
    });
    return () => {
      live = false;
    };
  }, [ids, store, online]);
  return { ...tray, items };
}

/** After a move: what happened, with Undo (the server's events, or the op taken back). */
export function useAfterMove(store: OfflineStore | null) {
  const { t } = useLingui();
  const offerUndo = useOfferUndo();
  return useCallback(
    (moved: Moved, title: string) => {
      if (moved.via === 'server') {
        offerUndo({ title }, moved.auditEvents);
        return;
      }
      toast(
        {
          title,
          description: t`On this phone; it syncs when you're online.`,
          tone: 'ok',
          action: {
            label: t`Undo`,
            onAction: () =>
              void store?.unqueue([moved.key]).then((gone) =>
                toast(
                  gone.length
                    ? { title: t`Undone`, tone: 'ok' }
                    : {
                        title: t`Couldn't undo that`,
                        description: t`It has already synced. Undo it from the thing's history.`,
                        tone: 'danger',
                      },
                ),
              ),
          },
        },
        { timeout: 10_000 },
      );
    },
    [offerUndo, store, t],
  );
}

export function TraySheet({
  store,
  online,
  isOpen,
  onClose,
  onScan,
  onMoved,
}: {
  store: OfflineStore | null;
  online: boolean;
  isOpen: boolean;
  onClose: () => void;
  /** "Scan destination": the scanner in tray mode. */
  onScan?: () => void;
  onMoved?: (to: PickedPlace) => void;
}) {
  const { t } = useLingui();
  const { items, remove } = useCarried(store, online);
  const [choosing, setChoosing] = useState(false);
  const count = items?.length ?? 0;
  const title = plural(count, { one: 'Carrying #', other: 'Carrying #' });
  return (
    <>
      <Sheet isOpen={isOpen && !choosing} onOpenChange={(o) => !o && onClose()} title={title}>
        <div className="grid gap-3">
          <p className="m-0 text-small text-ink-3">
            <Trans>The tray stays with you, offline too.</Trans>
          </p>
          {count === 0 ? (
            <p className="m-0 text-ink-2">
              <Trans>Nothing in the tray. Pick things up from their menu, or scan them.</Trans>
            </p>
          ) : (
            <ul aria-label={t`In the tray`} className="m-0 grid list-none gap-1.5 p-0">
              {items?.map((it) => (
                <li
                  key={it.id}
                  className="flex min-h-14 items-center gap-2 rounded-[10px] border border-line px-3 py-1.5"
                >
                  <div className="grid min-w-0 flex-1 gap-1">
                    <bdi className="font-semibold [overflow-wrap:anywhere]">
                      {'missing' in it ? t`Not on this phone` : (it.name ?? t`Unnamed`)}
                    </bdi>
                    {'missing' in it ? null : (
                      <IdChip code={it.shortCode} pending={it.shortCode === null} />
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t`Take out of tray`}
                    onPress={() => void remove([it.id])}
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {count > 0 ? (
            <div className="grid gap-2">
              {onScan ? (
                <Button onPress={onScan}>
                  <QrIcon className="size-5" />
                  <Trans>Scan destination</Trans>
                </Button>
              ) : null}
              <Button variant="secondary" onPress={() => setChoosing(true)}>
                <Trans>Choose a place</Trans>
              </Button>
              <Button variant="ghost" onPress={() => void remove()}>
                <Trans>Put them back</Trans>
              </Button>
            </div>
          ) : null}
        </div>
      </Sheet>
      {choosing && items ? (
        <ChoosePlace
          store={store}
          online={online}
          items={items}
          onClose={() => setChoosing(false)}
          onMoved={(to) => {
            setChoosing(false);
            onClose();
            onMoved?.(to);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * "Choose a place": online with everything synced, step 2's move dialog (the cross-location
 * warning, D45); otherwise the phone's places and a queued move.
 */
function ChoosePlace({
  store,
  online,
  items,
  onClose,
  onMoved,
}: {
  store: OfflineStore | null;
  online: boolean;
  items: (Described | { id: string; missing: true })[];
  onClose: () => void;
  onMoved: (to: PickedPlace) => void;
}) {
  const ids = items.map((i) => i.id);
  const first = items.find((i): i is Described => !('missing' in i));
  const [unsynced, setUnsynced] = useState<boolean | null>(null);
  const { remove } = useTray(store);
  useEffect(() => {
    void unsyncedCaptures(
      store,
      items.map((i) => i.id),
    ).then((u) => setUnsynced(u.length > 0));
  }, [store, items]);
  if (unsynced === null) return null;
  if (online && !unsynced && first)
    return (
      <MoveThingsDialog
        isOpen
        onOpenChange={(o) => !o && onClose()}
        thingIds={ids}
        fromLocationId={first.locationId}
        onMoved={(to) => {
          void remove();
          onMoved(to);
        }}
      />
    );
  return (
    <OfflineChoose store={store} online={online} ids={ids} onClose={onClose} onMoved={onMoved} />
  );
}

function OfflineChoose({
  store,
  online,
  ids,
  onClose,
  onMoved,
}: {
  store: OfflineStore | null;
  online: boolean;
  ids: string[];
  onClose: () => void;
  onMoved: (to: PickedPlace) => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const after = useAfterMove(store);
  const { remove } = useTray(store);
  const [to, setTo] = useState<PickedPlace | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pick = useCallback((p: PickedPlace) => setTo(p), []);
  const move = async () => {
    if (!to) return;
    setBusy(true);
    setProblem(null);
    try {
      const dest: Destination = { placeId: to.placeId };
      const moved = await moveCarried({
        store,
        online,
        thingIds: ids,
        to: dest,
        locationId: to.locationId,
      });
      await remove();
      after(
        moved,
        plural(ids.length, {
          one: `Moved # thing to ${to.name}`,
          other: `Moved # things to ${to.name}`,
        }),
      );
      onMoved(to);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet isOpen onOpenChange={(o) => !o && onClose()} title={t`Choose a place`}>
      <div className="grid gap-3">
        <WherePicker store={store} label={t`Where to`} value={to} onChange={pick} />
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button isDisabled={!to} isPending={busy} onPress={() => void move()}>
            {plural(ids.length, { one: 'Move # here', other: 'Move # here' })}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
