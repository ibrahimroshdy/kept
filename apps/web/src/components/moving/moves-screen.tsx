/**
 * Moving (1.x, D39 (5), D251): your moves, the ones in progress first. A move packs one location
 * into numbered boxes and unpacks them where it is going (another location, or rooms of the same
 * one). Each row says how many boxes are packed, in transit and unpacked.
 *
 * The list standard on the filter strip (D205, surface `moves`): search, location and status, with
 * saved views; the Display button sorts by when it started or by name and groups by location or
 * status. Offline, the moves this phone has opened are listed from its copy.
 *
 * Everyone who sees a location where Moving mode is on reads its moves; Start a move is for
 * members and above there, and needs a connection.
 */
import { can, MAX_MOVE_NAME, MOVE_STATUSES, type MoveStatus } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { isApiError } from '@/api/client';
import { movingApi, movingKeys, useMoves } from '@/api/moving/queries';
import type { MoveRow, MovesParams } from '@/api/moving/types';
import { useLocations } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { CheckCircleIcon, ChevronEndIcon, PlusIcon, TruckIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Notice, Page, Pill, useErrorText } from '@/components/page';
import { rowLink, Tile } from '@/components/places/rows';
import { useScanStore } from '@/components/scan/use-scan-store';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { sep } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { useListState } from '@/lib/url-state';
import { useBoxStateLabels, useMoveStatusLabels } from './labels';
import { oneValue, passes, useOrderedQuery } from './list';
import { RouteLine } from './move-screen';
import { rememberedMoves } from './offline';

const movingOn = (l: LocationDetail) => (l.effectiveModules ?? l.modules).includes('moving');

/** Where you may start a move: Moving mode on, members and above. */
export function useMoveLocations(): LocationDetail[] {
  const locations = useLocations();
  return (locations.data ?? []).filter((l) => movingOn(l) && can(l.role, 'things.edit'));
}

function MoveRowView({ move }: { move: MoveRow }) {
  const locationName = useLocationName();
  const states = useBoxStateLabels();
  const locations = useLocations().data ?? [];
  const from = locations.find((l) => l.id === move.locationId);
  const c = move.counts;
  return (
    <article aria-label={move.name}>
      <Link to="/moving/$id" params={{ id: move.id }} className={rowLink}>
        <Tile>
          <TruckIcon />
        </Tile>
        <span className="grid min-w-0 flex-1 gap-1">
          <bdi className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
            {move.name}
          </bdi>
          <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
            <RouteLine from={from ? locationName(from) : ''} to={move.toLocationName} />
            {sep()}
            <Plural value={c.total} one="# box" other="# boxes" />
          </span>
          <span className="flex flex-wrap gap-1.5">
            {move.status === 'done' ? (
              <Pill tone="ok" icon={<CheckCircleIcon />}>
                <Trans>Done</Trans>
              </Pill>
            ) : (
              <>
                {c.packed ? (
                  <Pill>
                    {states.packed} {c.packed}
                  </Pill>
                ) : null}
                {c.in_transit ? (
                  <Pill tone="warn">
                    {states.in_transit} {c.in_transit}
                  </Pill>
                ) : null}
                {c.unpacked ? (
                  <Pill tone="ok">
                    {states.unpacked} {c.unpacked}
                  </Pill>
                ) : null}
              </>
            )}
          </span>
        </span>
        <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
      </Link>
    </article>
  );
}

/** The moves this phone opened, as a list page, when the server can't be reached. */
function useOfflineMoves(enabled: boolean) {
  const store = useScanStore();
  const [moves, setMoves] = useState<MoveRow[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void rememberedMoves(store).then((m) => {
      if (live) setMoves(m.map(({ boxes: _b, ...row }) => row));
    });
    return () => {
      live = false;
    };
  }, [enabled, store]);
  return moves;
}

export function MovesScreen() {
  const { t } = useLingui();
  const [list] = useListState();
  const f = useFilterRegistry();
  const statuses = useMoveStatusLabels();
  const locations = useLocations();
  const locationName = useLocationName();
  const writable = useMoveLocations();
  const online = useOnline();
  const [starting, setStarting] = useState(false);
  const all = (locations.data ?? []).filter(movingOn);
  const names = new Map(all.map((l) => [l.id, locationName(l)]));

  const location = oneValue(list, 'location');
  const status = oneValue(list, 'status');
  const params: MovesParams = {
    ...(location ? { locationId: location } : {}),
    ...(status === 'active' || status === 'done' ? { status } : {}),
  };
  const server = useMoves(params);
  const offline = server.isError && isApiError(server.error) && server.error.code === 'offline';
  const kept = useOfflineMoves(offline);
  const query = offline
    ? ({
        ...server,
        isError: false,
        error: null,
        isPending: kept === null,
        data: kept
          ? { pages: [{ items: kept, next_cursor: null }], pageParams: [undefined] }
          : undefined,
      } as unknown as typeof server)
    : server;

  const sort = list.sort === 'name' ? 'name' : 'when';
  const dir = list.dir || (sort === 'when' ? 'desc' : 'asc');
  const group = list.group === 'location' || list.group === 'status' ? list.group : 'none';
  const q = list.q.trim().toLocaleLowerCase();
  const keep = useCallback(
    (m: MoveRow) => {
      if (!passes(list, 'location', m.locationId) || !passes(list, 'status', m.status))
        return false;
      if (!q) return true;
      return [m.name, names.get(m.locationId) ?? '', m.toLocationName ?? '']
        .join(' ')
        .toLocaleLowerCase()
        .includes(q);
    },
    [list, q, names],
  );
  const compare = useCallback(
    (a: MoveRow, b: MoveRow) => {
      if (group === 'location') {
        const g = (names.get(a.locationId) ?? '').localeCompare(names.get(b.locationId) ?? '');
        if (g) return g;
      }
      if (group === 'status') {
        const g = MOVE_STATUSES.indexOf(a.status) - MOVE_STATUSES.indexOf(b.status);
        if (g) return g;
      }
      const by =
        sort === 'name' ? a.name.localeCompare(b.name) : a.createdAt.localeCompare(b.createdAt);
      return dir === 'desc' ? -by : by;
    },
    [group, names, sort, dir],
  );
  const ordered = useOrderedQuery(query, keep, compare);

  const filters: FilterDef[] = [
    {
      key: 'status',
      label: t`Status`,
      icon: <CheckCircleIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: MOVE_STATUSES.map((s) => ({ value: s, label: statuses[s] })),
      },
    },
    ...(all.length > 1
      ? [
          {
            ...f.location(),
            values: {
              from: 'static' as const,
              options: all.map((l) => ({ value: l.id, label: locationName(l) })),
            },
          },
        ]
      : []),
  ];

  return (
    <Page
      title={t`Moving`}
      wide
      actions={
        writable.length ? (
          <Button size="small" isDisabled={!online} onPress={() => setStarting(true)}>
            <PlusIcon className="size-4" />
            <Trans>Start a move</Trans>
          </Button>
        ) : null
      }
    >
      {offline ? (
        <Notice tone="warn">
          <Trans>Offline: these are the moves this phone has opened.</Trans>
        </Notice>
      ) : null}
      <ListSurface<MoveRow>
        label={t`Moves`}
        search={{ label: t`Search moves`, placeholder: t`Name or location` }}
        filters={filters}
        surface="moves"
        sorts={[
          { value: 'when', label: t`Started`, kind: 'date' },
          { value: 'name', label: t`Name` },
        ]}
        groups={[
          { value: 'none', label: t`None` },
          { value: 'status', label: t`Status`, short: t`by status` },
          ...(all.length > 1
            ? [{ value: 'location', label: t`Location`, short: t`by location` }]
            : []),
        ]}
        query={ordered}
        getKey={(m) => m.id}
        groupOf={(m, by) =>
          by === 'location'
            ? { key: m.locationId, label: <bdi>{names.get(m.locationId) ?? ''}</bdi> }
            : by === 'status'
              ? { key: m.status, label: statuses[m.status] }
              : null
        }
        renderRow={(m) => <MoveRowView move={m} />}
        empty={
          <EmptyState
            icon={<TruckIcon />}
            title={<Trans>No moves yet</Trans>}
            action={
              writable.length && online ? (
                <Button onPress={() => setStarting(true)}>
                  <Trans>Start a move</Trans>
                </Button>
              ) : undefined
            }
          >
            <Trans>
              Moving house? Pack into numbered boxes, print a label and a contents sheet for each,
              and scan a box at the other end to unpack it into its room.
            </Trans>
          </EmptyState>
        }
      />
      <StartMoveSheet
        isOpen={starting}
        onClose={() => setStarting(false)}
        defaultLocationId={location}
      />
    </Page>
  );
}

const SAME = '';

/** Start a move: its name, the location being packed and where it is going. */
export function StartMoveSheet({
  isOpen,
  onClose,
  defaultLocationId,
}: {
  isOpen: boolean;
  onClose: () => void;
  defaultLocationId?: string | undefined;
}) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`Start a move`}>
      {isOpen ? <StartForm onClose={onClose} defaultLocationId={defaultLocationId} /> : null}
    </Sheet>
  );
}

function StartForm({
  onClose,
  defaultLocationId,
}: {
  onClose: () => void;
  defaultLocationId?: string | undefined;
}) {
  const { t } = useLingui();
  const writable = useMoveLocations();
  const all = useLocations().data ?? [];
  const locationName = useLocationName();
  const errorText = useErrorText();
  const online = useOnline();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [locationId, setLocationId] = useState(
    writable.find((l) => l.id === defaultLocationId)?.id ?? writable[0]?.id ?? '',
  );
  const [to, setTo] = useState<string>(SAME);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  // Where the boxes can go: any location you can add things to.
  const destinations = all.filter((l) => l.id !== locationId && can(l.role, 'things.edit'));
  const fromName = locationName(
    writable.find((l) => l.id === locationId) ?? { name: '', kind: 'home' },
  );

  const start = useMutation({
    mutationFn: () =>
      movingApi.start(locationId, { name: name.trim(), ...(to ? { toLocationId: to } : {}) }),
    onSuccess: async (move) => {
      await qc.invalidateQueries({ queryKey: movingKeys.all });
      onClose();
      await navigate({ to: '/moving/$id', params: { id: move.id } });
    },
  });

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) {
          setNameError(t`Give the move a name.`);
          return;
        }
        setNameError(null);
        start.mutate();
      }}
    >
      <TextField
        label={t`Name`}
        value={name}
        onChange={(v) => {
          setName(v);
          setNameError(null);
        }}
        maxLength={MAX_MOVE_NAME}
        placeholder={t`To the new house`}
        autoFocus
        {...(nameError ? { errorMessage: nameError, isInvalid: true } : {})}
      />
      {writable.length > 1 ? (
        <Select<{ id: string; name: string }>
          label={t`Packing up`}
          items={writable.map((l) => ({ id: l.id, name: locationName(l) }))}
          value={locationId}
          onChange={(key) => {
            if (key == null) return;
            setLocationId(String(key));
            setTo(SAME);
          }}
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              <bdi>{item.name}</bdi>
            </SelectItem>
          )}
        </Select>
      ) : null}
      <Select<{ id: string; name: string }>
        label={t`Going to`}
        items={[
          { id: SAME, name: t`Rooms of ${fromName}` },
          ...destinations.map((l) => ({ id: l.id, name: locationName(l) })),
        ]}
        value={to}
        onChange={(key) => setTo(key == null ? SAME : String(key))}
      >
        {(item) => (
          <SelectItem id={item.id} textValue={item.name}>
            <bdi>{item.name}</bdi>
          </SelectItem>
        )}
      </Select>
      <p className="m-0 text-small text-ink-2">
        <Trans>
          Moving to a new home? Add it as a location first, so each box can be unpacked into its
          rooms.
        </Trans>
      </p>
      {start.error ? <Notice tone="danger">{errorText(start.error)}</Notice> : null}
      {online ? null : (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection</Trans>
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={start.isPending} isDisabled={!online || !locationId}>
          <Trans>Start</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

export type { MoveStatus };
