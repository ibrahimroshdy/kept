/**
 * Changing a box's state and unpacking it (1.x, D251), with the toast that says so: Undo from the
 * server's event when it went straight there, or out of the queue while it waits on this phone
 * (as the carrying tray does, components/tray/tray.tsx).
 */
import type { BoxState } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useState } from 'react';
import type { Move, MoveBox } from '@/api/moving/types';
import { useOfferUndo } from '@/components/history/undo';
import { Notice, useErrorText } from '@/components/page';
import type { PickedPlace } from '@/components/places/move-picker';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type { OfflineStore } from '@/offline/store';
import { useBoxStateLabels, useBoxTitle } from './labels';
import { setBoxState, useRefreshBoard } from './offline';
import { RoomPicker } from './room-picker';

export type BoxWriteDeps = {
  store: OfflineStore | null;
  online: boolean;
  /** After an op was queued: the sync engine's kick. */
  onQueued?: (() => void) | undefined;
};

/** Writes a box's state (and to unpack, its room), then says so with Undo. */
export function useBoxWrite({ store, online, onQueued }: BoxWriteDeps) {
  const { t } = useLingui();
  const offerUndo = useOfferUndo();
  const refresh = useRefreshBoard();
  const states = useBoxStateLabels();
  const boxTitle = useBoxTitle();
  return useCallback(
    async (
      move: Pick<Move, 'id' | 'locationId'>,
      box: Pick<MoveBox, 'containerId' | 'number'>,
      state: BoxState,
      room?: PickedPlace | null,
    ) => {
      const written = await setBoxState({
        store,
        online,
        move,
        box,
        state,
        ...(room ? { placeId: room.placeId } : {}),
      });
      const name = boxTitle(box.number);
      const where = room?.name ?? '';
      const title =
        state === 'unpacked' && where
          ? t`${name} unpacked into ${where}`
          : t`${name}: ${states[state]}`;
      await refresh(move.id);
      if (written.via === 'server') {
        offerUndo({ title }, written.auditEvents, {
          thingId: box.containerId,
          onUndone: () => void refresh(move.id),
        });
        return written;
      }
      onQueued?.();
      toast(
        {
          title,
          description: t`On this phone; it syncs when you're online.`,
          tone: 'ok',
          action: {
            label: t`Undo`,
            onAction: () =>
              void store?.unqueue([written.key]).then(async (gone) => {
                await refresh(move.id);
                toast(
                  gone.length
                    ? { title: t`Undone`, tone: 'ok' }
                    : {
                        title: t`Couldn't undo that`,
                        description: t`It has already synced. Undo it from the thing's history.`,
                        tone: 'danger',
                      },
                );
              }),
          },
        },
        { timeout: 10_000 },
      );
      return written;
    },
    [store, online, onQueued, offerUndo, refresh, states, boxTitle, t],
  );
}

/**
 * Unpack a box: the room it goes to (its own when one was chosen at packing), then Unpack here.
 * The box moves into the room with everything inside it.
 */
export function UnpackPanel({
  store,
  online,
  onQueued,
  move,
  box,
  onDone,
}: BoxWriteDeps & {
  move: Pick<Move, 'id' | 'locationId' | 'toLocationId'>;
  box: MoveBox;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const write = useBoxWrite({ store, online, onQueued });
  const [room, setRoom] = useState<PickedPlace | null>(
    box.destination
      ? {
          placeId: box.destination.placeId,
          locationId: box.destination.locationId,
          name: box.destination.name,
        }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const destination = move.toLocationId ?? move.locationId;
  const where = room?.name ?? '';
  return (
    <div className="grid gap-3">
      <RoomPicker
        store={store}
        label={t`Goes to`}
        locationId={destination}
        value={room}
        onChange={(r) => {
          setRoom(r);
          setError(null);
        }}
      />
      <p className="m-0 text-small text-ink-2">
        <Trans>Everything in the box goes with it.</Trans>
      </p>
      {error ? <Notice tone="danger">{errorText(error)}</Notice> : null}
      <Button
        isDisabled={!room}
        isPending={busy}
        onPress={async () => {
          if (!room) return;
          setBusy(true);
          setError(null);
          try {
            await write(move, box, 'unpacked', room);
            onDone();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {room ? <Trans>Unpack into {where}</Trans> : <Trans>Choose a room</Trans>}
      </Button>
    </div>
  );
}
