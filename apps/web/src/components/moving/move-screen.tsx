/**
 * One move's board (1.x, D39 (5), D251; screens §11 "Moving board"): how many boxes are packed,
 * in transit and unpacked, which are still to arrive, and every box with the room it goes to.
 *
 * - **Pack:** Add a box (the next number), Print labels for the boxes (Labels, D43), the
 *   Contents sheets PDF; a box's page packs it.
 * - **Track:** each box's state, changed from its page or by Mark all in transit.
 * - **Unpack:** Scan to unpack opens the scanner for this move; a box's label (or its contents
 *   sheet's code) opens the unpack panel: choose its room, Unpack, and everything inside goes too.
 *
 * Offline it is the phone's copy, with the changes waiting on this phone shown at once
 * (./offline.ts). The list standard holds on the boxes (D205, surface `move-boxes`): search,
 * state and room, the Display button's sort (number, state) and grouping (state, room).
 * Viewers follow the board; members and above change it.
 */
import { BOX_STATES, type BoxState, can, isMissing } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useMutation,
  useQuery,
} from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { Page as PageOf } from '@/api/inventory/types';
import { movingApi } from '@/api/moving/queries';
import type { Move, MoveBox } from '@/api/moving/types';
import { useLocations } from '@/api/queries';
import type { FilterDef } from '@/components/filters/types';
import {
  CheckCircleIcon,
  ChevronEndIcon,
  CloudOffIcon,
  DocumentIcon,
  HomeIcon,
  PlusIcon,
  QrIcon,
  TagIcon,
  TruckIcon,
} from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  Notice,
  Page,
  Pill,
  useErrorText,
} from '@/components/page';
import { rowLink } from '@/components/places/rows';
import { useKick, useScanStore } from '@/components/scan/use-scan-store';
import { Button, buttonClass } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { useListState } from '@/lib/url-state';
import { useBoxWrite } from './box-write';
import { STATE_TONES, useBoxStateLabels, useBoxTitle, useMoveStatusLabels } from './labels';
import { passes } from './list';
import { type Board, useBoard, useRefreshBoard, waitingBoxes } from './offline';
import { AddBoxSheet, ContentsSheetsSheet } from './sheets';

export function MoveScreen({ id }: { id: string }) {
  const { t } = useLingui();
  const store = useScanStore();
  const online = useOnline();
  const board = useBoard(id, { store, online });
  if (board.isPending) return <LoadingRows rows={5} label={t`Loading the move`} />;
  if (board.isError)
    return (
      <Page title={t`Moving`} back="/moving">
        <ErrorState error={board.error} onRetry={() => board.refetch()} />
      </Page>
    );
  if (!board.data)
    return (
      <Page title={t`Moving`} back="/moving">
        <Notice tone="warn" title={t`Needs a connection`}>
          <Trans>Open this move once with a connection, and it is on this phone after that.</Trans>
        </Notice>
      </Page>
    );
  return <BoardView board={board.data} />;
}

function Counts({ move }: { move: Move }) {
  const states = useBoxStateLabels();
  const f = useFormat();
  return (
    <dl className="m-0 grid grid-cols-3 gap-2">
      {BOX_STATES.map((s) => (
        <div
          key={s}
          className="grid gap-0.5 rounded-xl border border-line bg-surface px-3 py-2.5 text-center"
        >
          <dt className="order-2 text-small text-ink-2">{states[s]}</dt>
          <dd className="order-1 m-0 font-semibold text-[22px] tabular-nums">
            {f.num(move.counts[s])}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** What is still to arrive: every box not unpacked yet, by number. */
function StillToArrive({ move }: { move: Move }) {
  const boxTitle = useBoxTitle();
  const missing = move.boxes.filter((b) => isMissing(b.state));
  if (move.boxes.length === 0) return null;
  if (missing.length === 0)
    return (
      <Notice tone="ok" title={<Trans>Every box is unpacked</Trans>}>
        {move.status === 'active' ? (
          <Trans>Mark the move done when you're settled in.</Trans>
        ) : null}
      </Notice>
    );
  return (
    <section aria-labelledby="still-to-arrive" className="grid gap-2">
      <h2 id="still-to-arrive" className="m-0 font-semibold text-[15px]">
        <Plural
          value={missing.length}
          one="# box still to unpack"
          other="# boxes still to unpack"
        />
      </h2>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {missing.map((b) => (
          <li key={b.containerId}>
            <Link
              to="/moving/$id/boxes/$boxId"
              params={{ id: move.id, boxId: b.containerId }}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-small text-ink no-underline outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-info"
            >
              <span className="font-semibold">{boxTitle(b.number)}</span>
              <Pill tone={STATE_TONES[b.state]} className="pointer-events-none">
                <StateWord state={b.state} />
              </Pill>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Garage → Home", the arrow pointing the reading direction. */
export function RouteLine({ from, to }: { from: string; to: string | null }) {
  return (
    <span>
      <bdi>{from}</bdi>
      {to ? (
        <>
          {' '}
          <span aria-hidden="true" className="inline-block rtl:-scale-x-100">
            →
          </span>{' '}
          <bdi>{to}</bdi>
        </>
      ) : null}
    </span>
  );
}

function StateWord({ state }: { state: BoxState }) {
  return <>{useBoxStateLabels()[state]}</>;
}

function BoxRow({ move, box, waiting }: { move: Move; box: MoveBox; waiting: boolean }) {
  const { t } = useLingui();
  const f = useFormat();
  const states = useBoxStateLabels();
  const boxTitle = useBoxTitle();
  const title = boxTitle(box.number);
  return (
    <article aria-label={title}>
      <Link
        to="/moving/$id/boxes/$boxId"
        params={{ id: move.id, boxId: box.containerId }}
        className={rowLink}
      >
        <span
          aria-hidden="true"
          className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-sunken font-semibold text-[17px] tabular-nums text-ink"
        >
          {f.num(box.number)}
        </span>
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
            {title}
            {box.name && box.name !== title ? (
              <span className="font-normal text-ink-2">
                {' · '}
                <bdi>{box.name}</bdi>
              </span>
            ) : null}
          </span>
          <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
            {box.destination ? (
              <Trans>
                Goes to <bdi>{box.destination.name}</bdi>
              </Trans>
            ) : (
              <Trans>No room chosen yet</Trans>
            )}
            {box.visible ? (
              <>
                {' · '}
                <Plural value={box.contents} one="# thing" other="# things" />
              </>
            ) : null}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <Pill tone={STATE_TONES[box.state]}>{states[box.state]}</Pill>
            {waiting ? (
              <Pill icon={<CloudOffIcon />}>
                <Trans>Waiting to sync</Trans>
              </Pill>
            ) : null}
            {!box.visible ? (
              <span className="text-small text-ink-3">{t`In a location you can't see`}</span>
            ) : null}
          </span>
        </span>
        <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
      </Link>
    </article>
  );
}

const PAGE = 50;

/** The board's boxes as the list surface's pages, `PAGE` at a time ("Load more"). */
function useBoxesQuery(boxes: MoveBox[]): UseInfiniteQueryResult<InfiniteData<PageOf<MoveBox>>> {
  const [pages, setPages] = useState(1);
  const shown = boxes.slice(0, pages * PAGE);
  return {
    data: {
      pages: [{ items: shown, next_cursor: shown.length < boxes.length ? 'more' : null }],
      pageParams: [undefined],
    },
    isPending: false,
    isError: false,
    error: null,
    hasNextPage: shown.length < boxes.length,
    isFetchingNextPage: false,
    fetchNextPage: async () => {
      setPages((n) => n + 1);
      return undefined as never;
    },
    refetch: async () => undefined as never,
  } as unknown as UseInfiniteQueryResult<InfiniteData<PageOf<MoveBox>>>;
}

function BoardView({ board }: { board: Board }) {
  const { t } = useLingui();
  const { move } = board;
  const store = useScanStore();
  const kick = useKick();
  const online = useOnline();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const f = useFormat();
  const refresh = useRefreshBoard();
  const locations = useLocations().data ?? [];
  const locationName = useLocationName();
  const statuses = useMoveStatusLabels();
  const states = useBoxStateLabels();
  const boxTitle = useBoxTitle();
  const write = useBoxWrite({ store, online, onQueued: kick });
  const [list] = useListState();
  const [adding, setAdding] = useState(false);
  const [sheets, setSheets] = useState(false);
  const [carrying, setCarrying] = useState(false);
  const from = locations.find((l) => l.id === move.locationId);
  const canWrite = !!from && can(from.role, 'things.edit');
  const waiting = useQuery({
    queryKey: ['moves', 'waiting', move.id, move.boxes.map((b) => b.state).join()],
    queryFn: () => waitingBoxes(store),
  }).data;

  const status = useMutation({
    mutationFn: (next: 'active' | 'done') =>
      movingApi.update(move.id, { status: next }, move.rowVersion),
    onSuccess: () => refresh(move.id),
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const remove = useMutation({
    mutationFn: () => movingApi.remove(move.id, move.rowVersion),
    onSuccess: async () => {
      await refresh(move.id);
      toast({ title: t`Move deleted. Its boxes stay where they are.`, tone: 'ok' });
      await navigate({ to: '/moving' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const rooms = [
    ...new Map(
      move.boxes
        .filter((b) => b.destination)
        .map((b) => [b.destination?.placeId as string, b.destination?.name as string]),
    ),
  ];
  const q = list.q.trim().toLocaleLowerCase();
  const keep = (b: MoveBox) => {
    if (!passes(list, 'state', b.state)) return false;
    if (!passes(list, 'room', b.destination?.placeId ?? null)) return false;
    if (!q) return true;
    return [
      boxTitle(b.number),
      String(b.number),
      b.name ?? '',
      b.destination?.name ?? '',
      b.shortCode ?? '',
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(q);
  };
  const sort = list.sort === 'state' ? 'state' : 'number';
  const group = list.group === 'state' || list.group === 'room' ? list.group : 'none';
  const ordered = move.boxes.filter(keep).sort((a, b) => {
    if (group === 'state') {
      const g = BOX_STATES.indexOf(a.state) - BOX_STATES.indexOf(b.state);
      if (g) return g;
    }
    if (group === 'room') {
      const g = (a.destination?.name ?? '￿').localeCompare(b.destination?.name ?? '￿');
      if (g) return g;
    }
    const by =
      sort === 'state'
        ? BOX_STATES.indexOf(a.state) - BOX_STATES.indexOf(b.state) || a.number - b.number
        : a.number - b.number;
    return list.dir === 'desc' ? -by : by;
  });
  const query = useBoxesQuery(ordered);

  const filters: FilterDef[] = [
    {
      key: 'state',
      label: t`State`,
      icon: <TruckIcon />,
      kind: 'multi',
      values: { from: 'static', options: BOX_STATES.map((s) => ({ value: s, label: states[s] })) },
    },
    ...(rooms.length
      ? [
          {
            key: 'room',
            label: t`Room`,
            icon: <HomeIcon />,
            kind: 'multi' as const,
            values: {
              from: 'static' as const,
              options: rooms.map(([value, label]) => ({ value, label })),
            },
          },
        ]
      : []),
  ];
  const packed = move.boxes.filter((b) => b.state === 'packed');
  const visibleIds = move.boxes.filter((b) => b.visible).map((b) => b.containerId);
  const route = <RouteLine from={from ? locationName(from) : ''} to={move.toLocationName} />;
  const asOf = board.asOf ? f.dateTime(board.asOf) : '';

  return (
    <Page title={<bdi>{move.name}</bdi>} back="/moving" eyebrow={route} wide>
      <div className="grid gap-4">
        <p className="m-0 text-small text-ink-2 md:hidden">{route}</p>
        {board.from === 'phone' ? (
          <Notice tone="warn" title={t`Offline`}>
            <Trans>
              As of {asOf}. Changes you make wait on this phone and sync when you're online.
            </Trans>
          </Notice>
        ) : null}
        {move.status === 'done' ? (
          <Notice tone="ok" title={statuses.done}>
            <Trans>This move is marked done. Open it again to change its boxes.</Trans>
          </Notice>
        ) : null}
        <Counts move={move} />
        {canWrite && move.status === 'active' ? (
          <div className="flex flex-wrap gap-2">
            <Button onPress={() => void navigate({ to: '/scan', search: { unpack: move.id } })}>
              <QrIcon className="size-4" />
              <Trans>Scan to unpack</Trans>
            </Button>
            <Button variant="secondary" isDisabled={!online} onPress={() => setAdding(true)}>
              <PlusIcon className="size-4" />
              <Trans>Add a box</Trans>
            </Button>
            {visibleIds.length ? (
              <Link
                to="/labels"
                search={{ loc: move.locationId, things: visibleIds.slice(0, 500).join(',') }}
                className={`${buttonClass('secondary')} no-underline [&_svg]:size-4`}
              >
                <TagIcon />
                <Trans>Print labels</Trans>
              </Link>
            ) : null}
            <Button
              variant="secondary"
              isDisabled={!online || move.boxes.length === 0}
              onPress={() => setSheets(true)}
            >
              <DocumentIcon className="size-4" />
              <Trans>Contents sheets</Trans>
            </Button>
            {packed.length ? (
              <Button
                variant="secondary"
                isPending={carrying}
                onPress={async () => {
                  const ok = await confirm({
                    title: t`Mark every packed box in transit?`,
                    body: (
                      <Plural
                        value={packed.length}
                        one="# box is going in the van."
                        other="# boxes are going in the van."
                      />
                    ),
                    confirmLabel: t`Mark in transit`,
                  });
                  if (!ok) return;
                  setCarrying(true);
                  try {
                    for (const b of packed) await write(move, b, 'in_transit');
                  } catch (e) {
                    toast({ title: errorText(e), tone: 'danger' });
                  } finally {
                    setCarrying(false);
                  }
                }}
              >
                <TruckIcon className="size-4" />
                <Trans>Mark all in transit</Trans>
              </Button>
            ) : null}
          </div>
        ) : null}
        <StillToArrive move={move} />
        <ListSurface<MoveBox>
          label={t`Boxes`}
          search={{ label: t`Search boxes`, placeholder: t`Number, name or room` }}
          filters={filters}
          surface="move-boxes"
          sorts={[
            { value: 'number', label: t`Number` },
            { value: 'state', label: t`State` },
          ]}
          groups={[
            { value: 'none', label: t`None` },
            { value: 'state', label: t`State`, short: t`by state` },
            { value: 'room', label: t`Room`, short: t`by room` },
          ]}
          query={query}
          getKey={(b) => b.containerId}
          groupOf={(b, by) =>
            by === 'state'
              ? { key: b.state, label: states[b.state] }
              : by === 'room'
                ? {
                    key: b.destination?.placeId ?? 'none',
                    label: b.destination ? <bdi>{b.destination.name}</bdi> : t`No room chosen yet`,
                  }
                : null
          }
          renderRow={(b) => (
            <BoxRow move={move} box={b} waiting={waiting?.has(b.containerId) ?? false} />
          )}
          empty={
            <EmptyState
              icon={<TruckIcon />}
              title={<Trans>No boxes yet</Trans>}
              action={
                canWrite && online && move.status === 'active' ? (
                  <Button onPress={() => setAdding(true)}>
                    <Trans>Add a box</Trans>
                  </Button>
                ) : undefined
              }
            >
              <Trans>
                Each box gets a number. Print its label, pack it, and scan it at the other end.
              </Trans>
            </EmptyState>
          }
        />
        {canWrite ? (
          <div className="flex flex-wrap gap-2 border-line border-t pt-4">
            {move.status === 'active' ? (
              <Button
                variant="secondary"
                isDisabled={!online}
                isPending={status.isPending}
                onPress={() => status.mutate('done')}
              >
                <CheckCircleIcon className="size-4" />
                <Trans>Mark the move done</Trans>
              </Button>
            ) : (
              <Button
                variant="secondary"
                isDisabled={!online}
                isPending={status.isPending}
                onPress={() => status.mutate('active')}
              >
                <Trans>Open it again</Trans>
              </Button>
            )}
            <Button
              variant="ghost"
              isDisabled={!online}
              isPending={remove.isPending}
              onPress={async () => {
                const ok = await confirm({
                  title: t`Delete this move?`,
                  body: t`The boxes and everything in them stay where they are; only their numbers and states go.`,
                  confirmLabel: t`Delete`,
                  destructive: true,
                });
                if (ok) remove.mutate();
              }}
            >
              <Trans>Delete the move</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      <AddBoxSheet
        isOpen={adding}
        onClose={() => setAdding(false)}
        move={move}
        onAdded={(containerId, number) => {
          const name = boxTitle(number);
          toast(
            {
              title: t`${name} added`,
              tone: 'ok',
              action: {
                label: t`Open it`,
                onAction: () =>
                  void navigate({
                    to: '/moving/$id/boxes/$boxId',
                    params: { id: move.id, boxId: containerId },
                  }),
              },
            },
            { timeout: 10_000 },
          );
        }}
      />
      <ContentsSheetsSheet isOpen={sheets} onClose={() => setSheets(false)} move={move} />
    </Page>
  );
}

export type { BoxState };
