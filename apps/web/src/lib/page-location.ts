/**
 * The location the page on screen belongs to, for the sidebar's Locations list (1.x, builds D224): it
 * stays on the location you are in while you open its places, things, containers, their tabs and
 * the location's settings, not only on the location's own page (D224's `/loc/<name>-<hex>`).
 *
 * Read from the router and from what the page has already loaded, never fetched: the route says
 * what the page is (a location, a place, a thing, an incident, a condition report), and the
 * row's `locationId` comes from the query cache the page fills (the same keys as its hooks). A
 * short-ID address resolves the way the page resolved it (lib/address.ts `knownAddress`). Until
 * the page has its row, and on pages that span locations (Home, Search, Inbox, Insights, lists,
 * Settings › Me …), there is none.
 */
import { notifyManager, type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { useCallback, useSyncExternalStore } from 'react';
import { conditionKeys } from '@/api/condition/queries';
import type { ConditionReport } from '@/api/condition/types';
import { householdKeys } from '@/api/household/queries';
import type { Incident } from '@/api/household/types';
import { inventoryKeys } from '@/api/inventory/queries';
import type { PlaceView, ThingView } from '@/api/inventory/types';
import { knownAddress, locationIdOf } from '@/lib/address';

/** `location` is the location's own page; `within` is another page naming one location by id. */
type RefKind = 'location' | 'within' | 'place' | 'thing' | 'incident' | 'condition';

export type PageLocation = {
  id: string;
  /** The location's own page (`/loc/…`), where its sidebar link is the current page. */
  own: boolean;
};

/** What the page is, as `kind|param`: one string, so the router's other changes re-render nothing. */
function usePageRef(): string {
  return useRouterState({
    select: (s) => {
      for (const m of [...s.matches].reverse()) {
        const params = m.params as Record<string, string | undefined>;
        const ref = (kind: RefKind, param: string | undefined) => (param ? `${kind}|${param}` : '');
        if (m.routeId.startsWith('/_app/settings/location/$id/')) return ref('within', params.id);
        switch (m.routeId) {
          case '/_app/loc/$id':
            return ref('location', params.id);
          case '/_app/p/$id':
            return ref('place', params.id);
          // A thing's tabs and sheets are its search (`?tab=`, `?sheet=`); a container is a thing,
          // and its box check is the container's.
          case '/_app/t/$id':
          case '/_app/box-check/$id':
            return ref('thing', params.id);
          case '/_app/incidents/$id':
            return ref('incident', params.id);
          case '/_app/condition-reports/$id':
            return ref('condition', params.id);
          case '/_app/reports/$kind': {
            // A report for an incident, or for one location (`?loc=`).
            const search = m.search as { incident?: unknown; loc?: unknown };
            if (typeof search.incident === 'string') return ref('incident', search.incident);
            return typeof search.loc === 'string' ? ref('within', search.loc) : '';
          }
        }
      }
      return '';
    },
  });
}

function locationIdIn(
  qc: QueryClient,
  kind: string,
  param: string,
  locations: readonly { id: string }[] | undefined,
): string | null {
  switch (kind) {
    case 'location':
    case 'within':
      return locationIdOf(param, locations) ?? null;
    case 'thing': {
      const id = knownAddress(qc, 'thing', param);
      return id
        ? (qc.getQueryData<ThingView>(inventoryKeys.things.detail(id))?.locationId ?? null)
        : null;
    }
    case 'place': {
      const id = knownAddress(qc, 'place', param);
      return id
        ? (qc.getQueryData<PlaceView>(inventoryKeys.places.detail(id))?.locationId ?? null)
        : null;
    }
    case 'incident':
      return qc.getQueryData<Incident>(householdKeys.incidents.one(param))?.locationId ?? null;
    case 'condition':
      return qc.getQueryData<ConditionReport>(conditionKeys.one(param))?.locationId ?? null;
    default:
      return null;
  }
}

/** The location the page belongs to, among `locations` (the sidebar's list), or null. */
export function usePageLocation(
  locations: readonly { id: string }[] | undefined,
): PageLocation | null {
  const qc = useQueryClient();
  const [kind = '', param = ''] = usePageRef().split('|');
  const cache = qc.getQueryCache();
  // Notified the way TanStack's own hooks are (batched, after the render that changed the cache),
  // so a page filling the cache never updates the sidebar mid-render.
  const subscribe = useCallback(
    (onChange: () => void) => cache.subscribe(notifyManager.batchCalls(onChange)),
    [cache],
  );
  const read = () => (kind ? locationIdIn(qc, kind, param, locations) : null);
  const id = useSyncExternalStore(subscribe, read, read);
  if (!id || !locations?.some((l) => l.id === id)) return null;
  return { id, own: kind === 'location' };
}
