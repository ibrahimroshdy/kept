/**
 * What's here (screens §5 Location / Place / Container): places first, then things, under the
 * list standard (L88: search, filter, group, sort and cursor pagination, all in the URL).
 *
 *   <ContentsList parent={{ kind: 'container', id, name, locationId }} canEdit={canEdit} />
 *
 * The host route declares the URL state with `validateSearch: contentsSearch`. The thing page
 * (task 26) hosts a container's contents with this; the Location and Place pages (task 25) use it
 * for theirs.
 *
 * - A location lists its top-level places, then every thing in it at any depth, each with its
 *   path; the "Unplaced" chip narrows to the Unplaced area.
 * - A place lists its child places, then the things directly in it.
 * - A container lists what's directly inside it; `view=photos` leads with a photo grid (D195),
 *   chosen under the strip's Display button with the sort, its direction and the grouping (D211).
 *
 * With `canEdit`, things can be selected and moved together (D45), picked up together into the
 * carrying tray (D175, design frame 7a: the tray is on this phone, so it works offline), or sent
 * to "Print labels" (T28); an owner or admin can also add them to an incident or make a claim pack
 * of them (D158, step-4 T26, screens §5 "Incidents and claims"). On a pointer device a thing can
 * be dragged onto a place row; the move picker does the same without dragging (WCAG 2.5.7).
 */
import { can } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { type InfiniteData, type UseInfiniteQueryResult, useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type DragEvent, type ReactNode, useMemo, useState } from 'react';
import { inventoryApi } from '@/api/inventory/queries';
import type { Page, PlaceNode, ThingListParams, ThingRow } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { ListExport } from '@/components/filters/list-export';
import { filterParams } from '@/components/filters/params';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { useOfferUndo } from '@/components/history/undo';
import { BoxIcon, CheckIcon } from '@/components/icons';
import { AddToIncidentSheet } from '@/components/incidents/lazy';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Notice, useErrorText } from '@/components/page';
import { useScanStore } from '@/components/scan/use-scan-store';
import { TrayIcon } from '@/components/tray/tray-icon';
import { pickUp } from '@/components/tray/use-tray';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { firstOf, useListState } from '@/lib/url-state';
import { cn } from '@/lib/utils';
import {
  rememberPlace,
  useContentsQuery,
  useInvalidateBrowse,
  usePlaceTree,
  useThingsQuery,
} from './api';
import { usePlaceName, useTypeName } from './labels';
import { MoveThingsDialog, placeMatches } from './move-picker';
import { PhotoTile, PlaceRowView, ThingRowView } from './rows';

export { CONTENTS_FILTERS, contentsSearch } from './contents-search';

export type ContentsParent =
  /** A location's top level. `unplacedId` is its Unplaced area, for the "Unplaced" chip. */
  | { kind: 'location'; locationId: string; name: string; unplacedId: string | null }
  | { kind: 'place'; id: string; locationId: string; name: string }
  | { kind: 'container'; id: string; locationId: string; name: string };

export type ContentsListProps = {
  parent: ContentsParent;
  /** The caller may change things here (`things.edit`): selection, Move, drag and drop. */
  canEdit: boolean;
  /** `photos` leads with a photo grid of the things (D195). Default: from the URL's `view`. */
  view?: 'list' | 'photos';
  /** Shown instead of the default empty state ("Nothing here yet" / "Box 3 is empty"). */
  empty?: ReactNode;
};

type Entry = { kind: 'place'; place: PlaceNode } | { kind: 'thing'; thing: ThingRow };
type EntryQuery = UseInfiniteQueryResult<InfiniteData<Page<Entry>>>;

const DRAG_TYPE = 'application/x-kept-thing';

export function ContentsList({ parent, canEdit, view, empty }: ContentsListProps) {
  const { t } = useLingui();
  const typeName = useTypeName();
  // Counts in the reader's digits (D143): "الأماكن · ٥", never "5" inside Arabic.
  const fmt = useFormat();
  const nameOf = usePlaceName();
  const [list] = useListState();
  const photos = (view ?? list.layout) === 'photos' && parent.kind === 'container';
  const where = firstOf(list, 'where');
  const f = useFilterRegistry();
  const common = {
    ...(list.q ? { q: list.q } : {}),
    ...(list.group && list.group !== 'none' ? { group: list.group as 'type' } : {}),
    ...(list.sort ? { sort: list.sort as 'name' | 'updated' | 'lastSeen' } : {}),
    ...(list.dir ? { dir: list.dir } : {}),
  };
  // A place's contents and the things list name the same filters differently.
  const contentsParams = {
    ...common,
    ...filterParams(list, {
      type: 'type',
      tag: 'tag',
      state: 'state',
      brand: 'brand',
      belongsTo: 'belongsTo',
    }),
  };
  const importRunId = firstOf(list, 'importRun');
  const params = {
    ...common,
    ...filterParams(list, {
      type: 'typeId',
      tag: 'tagId',
      state: 'state',
      brand: 'brandId',
      belongsTo: 'belongsToId',
    }),
    ...(importRunId && parent.kind !== 'place' ? { importRunId } : {}),
  } as ThingListParams;

  // One query per kind of parent; only the matching one is enabled.
  const isPlace = parent.kind === 'place';
  const placeQuery = useContentsQuery(isPlace ? parent.id : '', contentsParams, isPlace);
  // The things this list shows, as GET /things parameters: its query's, and for a place (whose
  // contents come from their own route) the things directly in it. "Export" sends these (T16).
  const thingParams: ThingListParams =
    parent.kind === 'container'
      ? { containerId: parent.id, ...params }
      : parent.kind === 'location'
        ? {
            locationId: parent.locationId,
            ...params,
            ...(where === 'unplaced' && parent.unplacedId ? { placeId: parent.unplacedId } : {}),
          }
        : { placeId: parent.id, ...params };
  const thingsQuery = useThingsQuery(isPlace ? {} : thingParams, !isPlace);
  const tree = usePlaceTree(parent.kind === 'location' ? parent.locationId : '');

  // Places are narrowed by the search text only; every filter is about things.
  const thingFilter = Object.keys(list.filters).length > 0;
  const topPlaces = useMemo(() => {
    if (thingFilter) return [];
    if (parent.kind === 'location')
      return (tree.data?.places ?? []).filter(
        (pl) => pl.parentId === null && !pl.isUnplaced && placeMatches(pl.name, list.q),
      );
    return null; // a place's children come with its contents
  }, [parent.kind, tree.data, list.q, thingFilter]);

  const query = useMemo<EntryQuery>(() => {
    const base = (isPlace ? placeQuery : thingsQuery) as unknown as EntryQuery;
    const pages = isPlace
      ? placeQuery.data?.pages.map((pg, i) => ({
          items: [
            ...(i === 0 && !thingFilter
              ? pg.places.map((place): Entry => ({ kind: 'place', place }))
              : []),
            ...pg.things.items.map((thing): Entry => ({ kind: 'thing', thing })),
          ],
          next_cursor: pg.things.next_cursor,
        }))
      : thingsQuery.data?.pages.map((pg, i) => ({
          items: [
            ...(i === 0 ? (topPlaces ?? []).map((place): Entry => ({ kind: 'place', place })) : []),
            ...pg.items.map((thing): Entry => ({ kind: 'thing', thing })),
          ],
          next_cursor: pg.next_cursor,
        }));
    const data = isPlace ? placeQuery.data : thingsQuery.data;
    const pending = base.isPending || (parent.kind === 'location' && tree.isPending);
    return {
      ...base,
      isPending: pending,
      data: data && pages ? { pages, pageParams: data.pageParams } : undefined,
    } as EntryQuery;
  }, [isPlace, placeQuery, thingsQuery, topPlaces, thingFilter, parent.kind, tree.isPending]);

  const entries = query.data?.pages.flatMap((pg) => pg.items) ?? [];
  const placeCount = fmt.num(entries.filter((e) => e.kind === 'place').length);
  const firstPlace = entries.find((e) => e.kind === 'place');
  const firstThing = entries.find((e) => e.kind === 'thing');
  const grouped = !!list.group && list.group !== 'none';
  const things = entries.flatMap((e) => (e.kind === 'thing' ? [e.thing] : []));

  // ----- selection and moves -----
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<string[] | null>(null);
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  // "Print labels" for the selection (plan T28), where the Labels module is on (§3: hidden if not).
  const navigate = useNavigate();
  const here = useLocations().data?.find((l) => l.id === parent.locationId);
  const canLabel =
    !!here &&
    (here.effectiveModules ?? here.modules).includes('labels') &&
    can(here.role, 'labels.use');
  // "Add to incident" and "Claim pack" (D158): owners and admins; online only (their screens read
  // the server; the sheet loads on demand).
  const canIncident =
    !!here &&
    (here.effectiveModules ?? here.modules).includes('warranties') &&
    can(here.role, 'incidents.manage');
  const online = useOnline();
  const [incidentFor, setIncidentFor] = useState<string[]>([]);

  // "Pick up" for the selection (D175, frame 7a): into this phone's carrying tray.
  const trayStore = useScanStore();
  const [pickingUp, setPickingUp] = useState(false);
  const pickUpSelected = async () => {
    if (!trayStore || selected.size === 0) return;
    setPickingUp(true);
    try {
      const n = selected.size;
      const carried = await pickUp(trayStore, [...selected]);
      toast({
        title: plural(n, { one: 'Picked up # thing', other: 'Picked up # things' }),
        description: plural(carried.length, { one: 'Carrying #', other: 'Carrying #' }),
        tone: 'ok',
        action: {
          label: t`Scan destination`,
          onAction: () => void navigate({ to: '/scan', search: { tray: 1 } }),
        },
      });
      stopSelecting();
    } catch {
      toast({ title: t`Couldn't pick them up on this phone.`, tone: 'danger' });
    } finally {
      setPickingUp(false);
    }
  };

  const errorText = useErrorText();
  const invalidate = useInvalidateBrowse();
  const offerUndo = useOfferUndo();
  const drop = useMutation({
    mutationFn: ({ thingId, place }: { thingId: string; place: PlaceNode }) =>
      inventoryApi.move({ thingIds: [thingId], to: { placeId: place.id } }),
    onSuccess: async ({ auditEvents }, { thingId, place }) => {
      rememberPlace(place.id);
      await invalidate();
      const what = things.find((x) => x.id === thingId)?.name ?? '';
      const to = nameOf(place);
      offerUndo({ title: t`Moved ${what} to ${to}` }, auditEvents);
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const [dropOn, setDropOn] = useState<string | null>(null);
  const dropProps = (place: PlaceNode) =>
    canEdit
      ? {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropOn(place.id);
          },
          onDragLeave: () => setDropOn((cur) => (cur === place.id ? null : cur)),
          onDrop: (e: DragEvent) => {
            const thingId = e.dataTransfer.getData(DRAG_TYPE);
            setDropOn(null);
            if (!thingId) return;
            e.preventDefault();
            drop.mutate({ thingId, place });
          },
        }
      : {};

  const unplaced =
    parent.kind === 'location' && parent.unplacedId
      ? tree.data?.places.find((pl) => pl.id === parent.unplacedId)
      : undefined;
  // "Imported by" (T16): owners and admins, who can see the location's imports; a place's
  // contents route has no such filter.
  const canImport = !!here && can(here.role, 'location.export-import') && parent.kind !== 'place';
  const filters: FilterDef[] = [
    ...(parent.kind === 'location' && parent.unplacedId
      ? [f.unplaced(unplaced?.thingCount ?? 0)]
      : []),
    f.type(),
    f.tag(),
    f.state(['uncertain', 'draft', 'ended']),
    f.brand(),
    f.belongsTo(),
    ...(canImport ? [f.importRun(parent.locationId)] : []),
  ];

  const heading = (text: ReactNode) => (
    <div className="eyebrow bg-sunken px-3.5 py-2" role="presentation">
      {text}
    </div>
  );

  const renderRow = (e: Entry) => {
    if (e.kind === 'place')
      return (
        <div
          {...dropProps(e.place)}
          className={cn(
            dropOn === e.place.id && 'bg-sunken outline-2 -outline-offset-2 outline-info',
          )}
        >
          {!grouped && e === firstPlace
            ? heading(
                <Trans>
                  Places · <span className="tabular-nums">{placeCount}</span>
                </Trans>,
              )
            : null}
          <PlaceRowView place={e.place} />
        </div>
      );
    const thing = e.thing;
    const checkbox = selecting ? (
      <label className="grid size-11 shrink-0 cursor-pointer place-items-center ps-2">
        <input
          type="checkbox"
          checked={selected.has(thing.id)}
          onChange={() => toggle(thing.id)}
          aria-label={t`Select ${thing.name ?? ''}`}
          className="size-5 accent-ink"
        />
      </label>
    ) : undefined;
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: drag is a pointer enhancement; the move picker is the accessible path
      <div
        draggable={canEdit && !selecting}
        onDragStart={(ev) => {
          ev.dataTransfer.setData(DRAG_TYPE, thing.id);
          ev.dataTransfer.effectAllowed = 'move';
        }}
      >
        {!grouped && e === firstThing && firstPlace
          ? heading(parent.kind === 'location' ? <Trans>Things</Trans> : <Trans>Things here</Trans>)
          : null}
        <ThingRowView thing={thing} showPath={parent.kind === 'location'} leading={checkbox} />
      </div>
    );
  };

  const emptyState = empty ?? (
    <EmptyState
      icon={<BoxIcon />}
      title={
        parent.kind === 'container' ? (
          <Trans>
            <bdi>{parent.name}</bdi> is empty
          </Trans>
        ) : (
          <Trans>Nothing here yet</Trans>
        )
      }
    >
      {canEdit ? <Trans>Use Add here to put the first thing in.</Trans> : null}
    </EmptyState>
  );

  const name = parent.name;
  return (
    <div className="grid min-w-0 gap-3">
      {photos && things.length ? (
        <section aria-label={t`Photos of what's in ${name}`} className="grid gap-2">
          <ul className="m-0 grid list-none grid-cols-3 gap-2 p-0 md:grid-cols-5">
            {things.map((thing) => (
              <li key={thing.id}>
                <PhotoTile thing={thing} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canEdit && things.length && selecting ? (
        <div
          role="toolbar"
          aria-label={t`Selection`}
          className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-surface p-2"
        >
          <span className="flex flex-1 items-center gap-2 ps-1 text-[14px] font-medium">
            <CheckIcon className="size-4" />
            {selected.size === 0 ? (
              <Trans>Choose things</Trans>
            ) : (
              <Trans>
                <span className="tabular-nums">{fmt.num(selected.size)}</span> selected
              </Trans>
            )}
          </span>
          <Button
            size="small"
            isDisabled={selected.size === 0}
            onPress={() => setMoving([...selected])}
          >
            <Trans>Move</Trans>
          </Button>
          {trayStore ? (
            <Button
              size="small"
              variant="secondary"
              isDisabled={selected.size === 0}
              isPending={pickingUp}
              onPress={() => void pickUpSelected()}
              className="[&_svg]:size-4"
            >
              <TrayIcon />
              <Trans>Pick up</Trans>
            </Button>
          ) : null}
          {canLabel ? (
            <Button
              size="small"
              variant="secondary"
              isDisabled={selected.size === 0}
              onPress={() =>
                void navigate({
                  to: '/labels',
                  search: { loc: parent.locationId, things: [...selected].join(',') },
                })
              }
            >
              <Trans>Print labels</Trans>
            </Button>
          ) : null}
          {canIncident ? (
            <>
              <Button
                size="small"
                variant="secondary"
                isDisabled={selected.size === 0 || !online}
                onPress={() => setIncidentFor([...selected])}
              >
                <Trans>Add to incident</Trans>
              </Button>
              <Button
                size="small"
                variant="secondary"
                isDisabled={selected.size === 0 || !online}
                onPress={() =>
                  void navigate({
                    to: '/reports/$kind',
                    params: { kind: 'claim-pack' },
                    search: { loc: parent.locationId, things: [...selected].join(',') },
                  })
                }
              >
                <Trans>Claim pack</Trans>
              </Button>
            </>
          ) : null}
          <Button size="small" variant="ghost" onPress={stopSelecting}>
            <Trans>Done</Trans>
          </Button>
        </div>
      ) : null}

      {drop.isPending ? (
        <Notice tone="info">
          <Trans>Moving…</Trans>
        </Notice>
      ) : null}

      <ListSurface<Entry>
        label={t`Contents of ${name}`}
        search={{
          label: t`Search ${name}`,
          placeholder: t`Search ${name}`,
          // Select and Export sit at the end of the search row, not alone on a row above it (UI
          // audit L5). Export is the list as it's filtered (D169): anyone who can see it.
          ...(!selecting && things.length
            ? {
                end: (
                  <span className="flex items-center gap-2">
                    {canEdit ? (
                      <Button size="small" variant="secondary" onPress={() => setSelecting(true)}>
                        <Trans>Select</Trans>
                      </Button>
                    ) : null}
                    <ListExport params={thingParams} />
                  </span>
                ),
              }
            : {}),
        }}
        filters={filters}
        surface="contents"
        groups={[
          { value: 'none', label: t`None` },
          { value: 'type', label: t`Type`, short: t`by type` },
        ]}
        sorts={[
          { value: 'name', label: t`Name` },
          { value: 'updated', label: t`Changed`, kind: 'date' },
          {
            value: 'lastSeen',
            label: t`Last seen`,
            // The Display button's word: short enough for the strip's one row at 375 px (D211).
            short: t({ message: 'Last seen', context: 'Display button' }),
            kind: 'date',
          },
        ]}
        {...(parent.kind === 'container' && !view
          ? {
              layouts: [
                { value: 'list', label: t`List` },
                { value: 'photos', label: t`Photos`, short: t`photos` },
              ],
            }
          : {})}
        query={query}
        getKey={(e) => (e.kind === 'place' ? `p:${e.place.id}` : `t:${e.thing.id}`)}
        renderRow={renderRow}
        groupOf={(e) =>
          e.kind === 'place'
            ? { key: '__places', label: <Trans>Places</Trans> }
            : {
                key: e.thing.type?.id ?? '__none',
                label: typeName(e.thing.type) ?? <Trans>No type</Trans>,
              }
        }
        empty={emptyState}
      />

      {incidentFor.length ? (
        <AddToIncidentSheet
          locationId={parent.locationId}
          thingIds={incidentFor}
          onClose={() => setIncidentFor([])}
          onAdded={stopSelecting}
        />
      ) : null}

      {moving ? (
        <MoveThingsDialog
          isOpen
          onOpenChange={(open) => !open && setMoving(null)}
          thingIds={moving}
          fromLocationId={parent.locationId}
          onMoved={() => {
            setMoving(null);
            stopSelecting();
          }}
        />
      ) : null}
    </div>
  );
}
