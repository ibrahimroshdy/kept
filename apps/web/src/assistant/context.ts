/**
 * What the assistant knows about the page it was opened over (D24, screens §5 "Assistant"): the
 * location, place or thing on screen, the search typed, or the inbox. The sheet shows it as a
 * removable chip (./context-chip.tsx); the question carries it as `context: {kind, id}`, and with
 * the chip removed as `context: none`. Read from the router, so the docked panel follows the page.
 *
 * A thing's or place's page address may be its short ID (D208): it's resolved the way the page
 * resolves it (lib/address.ts), from the same cache, so the context names the id, never the code.
 */
import { type ContextKind, isShortCode, normaliseInputCode } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { inventoryApi, inventoryKeys } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { usePlaceName } from '@/components/places/labels';
import { isUuid, resolveAddress } from '@/lib/address';
import { useLocationName } from '@/lib/labels';

export type PageContext = {
  /** Stable for the page: removing the chip remembers it (./store.ts `removedContext`). */
  key: string;
  kind: Exclude<ContextKind, 'none'>;
  /** What the server takes as `context.id`: a location's, place's or thing's id, or the query. */
  id?: string;
  locationId?: string;
  /** The chip's words: a name (the person's own text, shown bidi-isolated) or Kept's own. */
  label: string;
};

/** The page's route and its parameter, as one string, so the router's other changes don't
 * re-render the assistant. */
function usePageKey(): string {
  return useRouterState({
    select: (s) => {
      for (const m of [...s.matches].reverse()) {
        const params = m.params as Record<string, string | undefined>;
        switch (m.routeId) {
          case '/_app/loc/$id':
            return `location|${params.id ?? ''}`;
          case '/_app/p/$id':
            return `place|${params.id ?? ''}`;
          case '/_app/t/$id':
            return `thing|${params.id ?? ''}`;
          case '/_app/search': {
            const q = (m.search as { q?: unknown }).q;
            return typeof q === 'string' && q.trim() ? `search|${q.trim().slice(0, 200)}` : '';
          }
          case '/_app/inbox':
            return 'inbox|';
        }
      }
      return '';
    },
  });
}

/** A thing's or place's id from its address (a UUID, or a short ID resolved once and cached). */
function useAddressId(kind: 'thing' | 'place', param: string, on: boolean): string | null {
  const uuid = isUuid(param);
  const code = on && !uuid ? normaliseInputCode(param) : '';
  const resolved = useQuery({
    queryKey: ['address', kind, code],
    queryFn: async () => (await resolveAddress(kind, code)) ?? null,
    enabled: on && !uuid && isShortCode(code),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (!on) return null;
  return uuid ? param.toLowerCase() : (resolved.data ?? null);
}

/** The page's context, or null where the page has none (Home, settings, …). */
export function usePageContext(): PageContext | null {
  const { t } = useLingui();
  const key = usePageKey();
  const [kind = '', param = ''] = key.split('|');
  const locations = useLocations();
  const locationName = useLocationName();
  const placeName = usePlaceName();
  const thingId = useAddressId('thing', param, kind === 'thing');
  const placeId = useAddressId('place', param, kind === 'place');
  const thing = useQuery({
    queryKey: inventoryKeys.things.detail(thingId ?? ''),
    queryFn: () => inventoryApi.thing(thingId as string),
    enabled: !!thingId,
  });
  const place = useQuery({
    queryKey: inventoryKeys.places.detail(placeId ?? ''),
    queryFn: () => inventoryApi.place(placeId as string),
    enabled: !!placeId,
  });

  switch (kind) {
    case 'location': {
      const l = locations.data?.find((x) => x.id === param);
      return l
        ? { key, kind: 'location', id: l.id, locationId: l.id, label: locationName(l) }
        : null;
    }
    case 'place':
      return place.data
        ? {
            key,
            kind: 'place',
            id: place.data.id,
            locationId: place.data.locationId,
            label: placeName(place.data),
          }
        : null;
    case 'thing':
      return thing.data
        ? {
            key,
            kind: 'thing',
            id: thing.data.id,
            locationId: thing.data.locationId,
            label: thing.data.name ?? t`Untitled draft`,
          }
        : null;
    case 'search':
      return { key, kind: 'search', id: param, label: param };
    case 'inbox':
      return { key, kind: 'inbox', label: t`Inbox` };
    default:
      return null;
  }
}

/** The context a question carries: the page's, or `none` once the chip is removed (D24). */
export function contextBody(
  page: PageContext | null,
  removed: string | null,
): { kind: ContextKind; id?: string } {
  if (!page || page.key === removed) return { kind: 'none' };
  return page.id ? { kind: page.kind, id: page.id } : { kind: page.kind };
}
