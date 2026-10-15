/**
 * One box of a move (1.x, D251): its number, where it is now and the room it goes to, what is
 * directly inside it, and its state.
 *
 * - **Pack:** Open the box goes to the container's own page (Add here, Move, the box check);
 *   Pack with the scanner opens the carrying tray (D175): scan things to pick them up, then this
 *   box's label to put them in. Both work offline.
 * - **Print:** its label (Labels), and its contents sheet (a one-page PDF).
 * - **Track:** In transit and Back to packed; Unpack chooses its room and moves the box with
 *   everything inside it. These work offline too (./offline.ts).
 *
 * What is inside comes from the server when online, else from the phone's snapshot
 * (boxcheck/load.ts). Viewers read; members and above change it.
 */
import { can } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { movingApi } from '@/api/moving/queries';
import type { Move, MoveBox } from '@/api/moving/types';
import { useLocations } from '@/api/queries';
import { loadBox } from '@/components/boxcheck/load';
import { BoxIcon, DocumentIcon, HomeIcon, QrIcon, TagIcon, TruckIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import {
  EmptyState,
  ErrorState,
  List,
  LoadingRows,
  Notice,
  Page,
  Pill,
  Row,
  Section,
  useErrorText,
} from '@/components/page';
import { type PickedPlace, PlacePicker } from '@/components/places/move-picker';
import { useKick, useScanStore } from '@/components/scan/use-scan-store';
import { Sheet } from '@/components/things/sheet';
import { Button, buttonClass } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { UnpackPanel, useBoxWrite } from './box-write';
import { STATE_TONES, useBoxStateLabels, useBoxTitle } from './labels';
import { useBoard, useRefreshBoard } from './offline';
import { ContentsSheetsSheet } from './sheets';

const linkButton = `${buttonClass('secondary')} no-underline hover:bg-sunken [&_svg]:size-4`;

export function BoxScreen({ moveId, boxId }: { moveId: string; boxId: string }) {
  const { t } = useLingui();
  const store = useScanStore();
  const online = useOnline();
  const board = useBoard(moveId, { store, online });
  const back = { to: '/moving/$id' as const, params: { id: moveId } };
  if (board.isPending) return <LoadingRows rows={4} label={t`Loading the box`} />;
  if (board.isError)
    return (
      <Page title={t`Box`} back={back}>
        <ErrorState error={board.error} onRetry={() => board.refetch()} />
      </Page>
    );
  const move = board.data?.move;
  const box = move?.boxes.find((b) => b.containerId === boxId);
  if (!move || !box)
    return (
      <Page title={t`Box`} back={back}>
        <Notice tone="warn" title={t`Not a box of this move`} />
      </Page>
    );
  return <BoxView move={move} box={box} />;
}

function BoxView({ move, box }: { move: Move; box: MoveBox }) {
  const { t } = useLingui();
  const store = useScanStore();
  const kick = useKick();
  const online = useOnline();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const f = useFormat();
  const states = useBoxStateLabels();
  const boxTitle = useBoxTitle();
  const refresh = useRefreshBoard();
  const write = useBoxWrite({ store, online, onQueued: kick });
  const locations = useLocations().data ?? [];
  const from = locations.find((l) => l.id === move.locationId);
  const canWrite = !!from && can(from.role, 'things.edit') && move.status === 'active';
  const [unpacking, setUnpacking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = boxTitle(box.number);
  const contents = useQuery({
    queryKey: ['moves', 'box-contents', box.containerId, box.state, online],
    queryFn: () => loadBox(box.containerId, { store, online }),
    enabled: box.visible,
    retry: false,
  });
  const remove = useMutation({
    mutationFn: () => movingApi.removeBox(move.id, box.containerId),
    onSuccess: async () => {
      await refresh(move.id);
      toast({ title: t`${title} taken out of the move. The box stays where it is.`, tone: 'ok' });
      await navigate({ to: '/moving/$id', params: { id: move.id } });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const mark = async (state: 'packed' | 'in_transit') => {
    setBusy(true);
    try {
      await write(move, box, state);
    } catch (e) {
      toast({ title: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const lines = contents.data?.lines ?? [];
  const when = f.dateTime(box.stateAt);
  const by = box.stateBy?.displayName ?? '';
  return (
    <Page
      title={title}
      back={{ to: '/moving/$id', params: { id: move.id } }}
      eyebrow={<bdi>{move.name}</bdi>}
    >
      <div className="grid gap-4">
        <div className="grid gap-2 rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={STATE_TONES[box.state]}>{states[box.state]}</Pill>
            {box.shortCode ? <IdChip code={box.shortCode} /> : null}
            {box.name && box.name !== title ? (
              <bdi className="text-ink-2 [overflow-wrap:anywhere]">{box.name}</bdi>
            ) : null}
          </div>
          <p className="m-0 text-small text-ink-2">
            {by ? (
              <Trans>
                Since {when}, by <bdi>{by}</bdi>
              </Trans>
            ) : (
              <Trans>Since {when}</Trans>
            )}
          </p>
          <div className="grid gap-0.5">
            <span className="text-small text-ink-3">
              <Trans>Goes to</Trans>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <bdi className="font-semibold text-[20px] [overflow-wrap:anywhere]">
                {box.destination?.name ?? t`No room chosen yet`}
              </bdi>
              {canWrite ? (
                <Button
                  variant="ghost"
                  size="small"
                  isDisabled={!online}
                  onPress={() => setChoosing(true)}
                >
                  {box.destination ? <Trans>Change</Trans> : <Trans>Choose</Trans>}
                </Button>
              ) : null}
            </span>
          </div>
          {box.visible && box.where ? (
            <p className="m-0 text-small text-ink-2 [overflow-wrap:anywhere]">
              <Trans>
                Now in <bdi>{box.where}</bdi>
              </Trans>
            </p>
          ) : null}
          {!box.visible ? (
            <Notice>
              <Trans>It was unpacked into a location you can't see.</Trans>
            </Notice>
          ) : null}
        </div>

        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            {box.state !== 'unpacked' ? (
              <Button onPress={() => setUnpacking(true)} isDisabled={!box.visible}>
                <HomeIcon className="size-4" />
                <Trans>Unpack</Trans>
              </Button>
            ) : null}
            {box.state === 'packed' ? (
              <Button variant="secondary" isPending={busy} onPress={() => void mark('in_transit')}>
                <TruckIcon className="size-4" />
                <Trans>Mark in transit</Trans>
              </Button>
            ) : (
              <Button variant="secondary" isPending={busy} onPress={() => void mark('packed')}>
                <BoxIcon className="size-4" />
                <Trans>Back to packed</Trans>
              </Button>
            )}
          </div>
        ) : null}

        {box.visible ? (
          <Section
            title={<Plural value={lines.length} one="Inside: # thing" other="Inside: # things" />}
          >
            {contents.isPending ? (
              <LoadingRows rows={2} label={t`Loading what's inside`} />
            ) : lines.length === 0 ? (
              <EmptyState icon={<BoxIcon />} title={<Trans>Nothing in it yet</Trans>}>
                <Trans>Open the box to add things here, or pack with the scanner.</Trans>
              </EmptyState>
            ) : (
              <List>
                {lines.map((l) => (
                  <li key={l.id}>
                    <Link
                      to="/t/$id"
                      params={{ id: l.id }}
                      className="block text-ink no-underline outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
                    >
                      <Row
                        title={
                          <bdi className="[overflow-wrap:anywhere]">{l.name ?? t`Unnamed`}</bdi>
                        }
                        subtitle={
                          l.isContainer && l.inside !== null ? (
                            <Plural value={l.inside} one="Holds # thing" other="Holds # things" />
                          ) : undefined
                        }
                        trailing={
                          <span className="flex items-center gap-2">
                            {l.quantity !== 1 ? (
                              <span className="text-small text-ink-2 tabular-nums">
                                ×{f.num(l.quantity)}
                              </span>
                            ) : null}
                            {l.shortCode ? <IdChip code={l.shortCode} /> : null}
                          </span>
                        }
                      />
                    </Link>
                  </li>
                ))}
              </List>
            )}
            {contents.data?.from === 'phone' ? (
              <p className="m-0 text-small text-ink-3">
                <Trans>As this phone last saw it.</Trans>
              </p>
            ) : null}
          </Section>
        ) : null}

        {box.visible ? (
          <div className="flex flex-wrap gap-2">
            <Link to="/t/$id" params={{ id: box.containerId }} className={linkButton}>
              <BoxIcon />
              <Trans>Open the box</Trans>
            </Link>
            {canWrite ? (
              <Link to="/scan" search={{ tray: 1 }} className={linkButton}>
                <QrIcon />
                <Trans>Pack with the scanner</Trans>
              </Link>
            ) : null}
            {canWrite ? (
              <Link
                to="/labels"
                search={{ loc: box.locationId ?? move.locationId, things: box.containerId }}
                className={linkButton}
              >
                <TagIcon />
                <Trans>Print its label</Trans>
              </Link>
            ) : null}
            <Button variant="secondary" isDisabled={!online} onPress={() => setSheet(true)}>
              <DocumentIcon className="size-4" />
              <Trans>Contents sheet</Trans>
            </Button>
          </div>
        ) : null}

        {canWrite ? (
          <div className="border-line border-t pt-4">
            <Button
              variant="ghost"
              isDisabled={!online}
              isPending={remove.isPending}
              onPress={async () => {
                const ok = await confirm({
                  title: t`Take ${title} out of the move?`,
                  body: t`The box and what's in it stay where they are.`,
                  confirmLabel: t`Take it out`,
                });
                if (ok) remove.mutate();
              }}
            >
              <Trans>Take it out of the move</Trans>
            </Button>
          </div>
        ) : null}
      </div>

      <Sheet isOpen={unpacking} onOpenChange={setUnpacking} title={t`Unpack ${title}`}>
        {unpacking ? (
          <UnpackPanel
            store={store}
            online={online}
            onQueued={kick}
            move={move}
            box={box}
            onDone={() => setUnpacking(false)}
          />
        ) : null}
      </Sheet>
      <Sheet isOpen={choosing} onOpenChange={setChoosing} title={t`Room it goes to`}>
        {choosing ? <ChooseRoom move={move} box={box} onClose={() => setChoosing(false)} /> : null}
      </Sheet>
      <ContentsSheetsSheet
        isOpen={sheet}
        onClose={() => setSheet(false)}
        move={move}
        containerIds={[box.containerId]}
      />
    </Page>
  );
}

/** The room a box goes to, printed on its contents sheet; needs a connection. */
function ChooseRoom({ move, box, onClose }: { move: Move; box: MoveBox; onClose: () => void }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const online = useOnline();
  const refresh = useRefreshBoard();
  const [room, setRoom] = useState<PickedPlace | null>(
    box.destination
      ? {
          placeId: box.destination.placeId,
          locationId: box.destination.locationId,
          name: box.destination.name,
        }
      : null,
  );
  const save = useMutation({
    mutationFn: () =>
      movingApi.updateBox(move.id, box.containerId, { destinationPlaceId: room?.placeId ?? null }),
    onSuccess: async () => {
      await refresh(move.id);
      onClose();
    },
  });
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <PlacePicker
        label={t`Room it goes to`}
        locationIds={[move.toLocationId ?? move.locationId]}
        includeUnplaced={false}
        value={room}
        onChange={setRoom}
      />
      {save.error ? <Notice tone="danger">{errorText(save.error)}</Notice> : null}
      {online ? null : (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection</Trans>
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={save.isPending} isDisabled={!online || !room}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
