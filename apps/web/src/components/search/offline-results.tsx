/**
 * Search offline (D17, D36, D188; screens §5 Search, §8): the Things group answers from the
 * phone's copy instead of the server. `OfflineStore.search()` is the `normalize()` twin of the
 * server's search (names, aliases, the short ID, legacy and own codes, Arabic folding: D42,
 * D208), and its answer includes captures still waiting to sync, "ID pending" (D112). Each row
 * says where the thing is from the snapshot's places, and the group says how old the copy is:
 * "On this phone · as of last sync, 14:02".
 *
 * Offline it filters by the words, the location and the type; place, tag, state and price need
 * the server, and the page says so rather than answering as if they applied. The other groups
 * (places, people, shops, documents) have no copy on the phone: documents say they need a
 * connection (components/search/documents.tsx), the rest wait.
 */
import type { SnapPlace, SnapThing } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import type { PathStep, SearchParams, ThingRow } from '@/api/inventory/types';
import type { LocationKind } from '@/api/types';
import { placePath } from '@/components/capture/target';
import { SearchIcon } from '@/components/icons';
import { EmptyState, List, Section } from '@/components/page';
import { sep, useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { asOfTime } from '@/offline/as-of';
import type { OfflineStore } from '@/offline/store';
import { queryForms, ThingResult } from './results';

/** At most this many rows from the phone (the list standard's first page). */
export const OFFLINE_LIMIT = 50;

const many = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** Whether a row passes the filters the phone can apply: location and type, "is" or "is not". */
export function passesOffline(params: SearchParams) {
  const locations = many(params.locationId);
  const types = many(params.typeId);
  const not = new Set(params.not ?? []);
  return (t: SnapThing): boolean => {
    if (locations.length && locations.includes(t.locationId) === not.has('locationId'))
      return false;
    if (types.length && types.includes(t.typeId ?? '') === not.has('typeId')) return false;
    return true;
  };
}

/** A filter only the server can apply is set. */
export const serverOnlyFilters = (params: SearchParams) =>
  many(params.placeId).length > 0 ||
  many(params.tagId).length > 0 ||
  many(params.state).length > 0 ||
  !!params.priceMin ||
  !!params.priceMax;

const placeStep = (p: SnapPlace): PathStep => ({
  id: p.id,
  name: p.name,
  kind: 'place',
  isUnplaced: p.isUnplaced,
});

/** A phone row in the server's row shape, so it reads like every other search result. */
function rowOf(t: SnapThing, path: PathStep[]): ThingRow {
  return {
    id: t.id,
    locationId: t.locationId,
    shortCode: t.shortCode,
    name: t.name,
    type: null,
    quantity: Number(t.quantity) || 1,
    lifecycle: t.lifecycle,
    derivedState: [
      ...(t.locationUncertain ? (['uncertain'] as const) : []),
      ...(t.reviewState === 'draft' ? (['draft'] as const) : []),
      // Lent, borrowed and in repair ride on the snapshot (step-4 plan Q34).
      ...(t.derived ?? []),
    ],
    path,
    containerThumbUrl: null,
    thumbUrl: null,
    lastSeenAt: t.lastSeenAt,
    isContainer: t.isContainer,
  };
}

type Found = {
  rows: ThingRow[];
  asOf: string | null;
  locationNames: Map<string, { kind: string; name: string }>;
};

/** The phone's answer to `params`: rows with their paths, best match first. */
export async function searchPhone(store: OfflineStore, params: SearchParams): Promise<Found> {
  const q = params.q?.trim() ?? '';
  const [hits, asOf, locations] = await Promise.all([
    q ? store.search(q, OFFLINE_LIMIT) : Promise.resolve([]),
    store.asOf(),
    store.locations(),
  ]);
  const places = new Map<string, SnapPlace[]>();
  const rows: ThingRow[] = [];
  for (const t of hits.filter(passesOffline(params))) {
    let inLocation = places.get(t.locationId);
    if (!inLocation) {
      inLocation = await store.placesOf(t.locationId);
      places.set(t.locationId, inLocation);
    }
    const box = t.containerId ? await store.thing(t.containerId) : undefined;
    const path = box
      ? [
          ...placePath(inLocation, box.placeId).map(placeStep),
          { id: box.id, name: box.name ?? '', kind: 'container' as const, isUnplaced: false },
        ]
      : placePath(inLocation, t.placeId).map(placeStep);
    rows.push(rowOf(t, path));
  }
  return { rows, asOf, locationNames: new Map(locations.map((l) => [l.id, l])) };
}

export function OfflineResults({
  store,
  params,
  onOpen,
}: {
  store: OfflineStore;
  params: SearchParams;
  onOpen?: (() => void) | undefined;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const { locale, digits } = usePrefs();
  const nameOf = useLocationName();
  const [found, setFound] = useState<Found | null>(null);
  const key = JSON.stringify(params);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `params`, by value
  useEffect(() => {
    let live = true;
    void searchPhone(store, params)
      .then((r) => {
        if (live) setFound(r);
      })
      .catch(() => {
        if (live) setFound({ rows: [], asOf: null, locationNames: new Map() });
      });
    return () => {
      live = false;
    };
  }, [store, key]);

  if (!found) return null;
  const q = params.q?.trim() ?? '';
  const forms = queryForms(q);
  const time = found.asOf ? asOfTime(found.asOf, formatLocale(locale, digits)) : null;
  const locName = (id: string) => {
    const l = found.locationNames.get(id);
    return l ? nameOf({ kind: l.kind as LocationKind, name: l.name }) : '';
  };
  const order: string[] = [];
  for (const r of found.rows) if (!order.includes(r.locationId)) order.push(r.locationId);
  const grouped = order.flatMap((loc) => found.rows.filter((r) => r.locationId === loc));
  const partial = serverOnlyFilters(params) || !q;

  return (
    <div className="grid gap-3">
      <p className="m-0 text-small text-ink-2">
        {time ? t`On this phone · as of last sync, ${time}` : t`On this phone`}
      </p>
      {partial ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>
            Offline, search uses the words, the location and the type. The other filters apply when
            you're back online.
          </Trans>
        </p>
      ) : null}
      {grouped.length > 0 ? (
        <Section
          title={
            <>
              <Trans>Things</Trans>{' '}
              <span className="font-normal normal-case tracking-normal text-ink-3">
                {sep()}
                {f.num(grouped.length)}
              </span>
            </>
          }
        >
          <List aria-label={t`Things found`}>
            {grouped.map((row, i) => (
              <li key={row.id}>
                {order.length > 1 && grouped[i - 1]?.locationId !== row.locationId ? (
                  <div className="eyebrow bg-sunken px-3.5 py-2" role="presentation">
                    <bdi>{locName(row.locationId)}</bdi>
                  </div>
                ) : null}
                <ThingResult
                  thing={row}
                  forms={forms}
                  locationName={locName(row.locationId)}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </List>
        </Section>
      ) : q ? (
        <EmptyState
          icon={<SearchIcon />}
          title={
            <Trans>
              Nothing on this phone matches ‘<bdi>{q}</bdi>’
            </Trans>
          }
        >
          <Trans>Everything is searched again when you're back online.</Trans>
        </EmptyState>
      ) : null}
    </div>
  );
}
