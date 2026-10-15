/**
 * Short-ID addresses (D208; engineering spec §7.16, plan T17a). A thing's page is `/t/<short-id>`
 * and a place's `/p/<short-id>` once the short ID exists; both routes also take the UUIDv7 (a
 * thing created offline has no short ID until the server allocates it at sync, D112, and links
 * already shared keep working).
 *
 * - `addressOf()` is what a link the app renders uses: the short ID when the row carries one.
 * - `useAddress()` turns a route's parameter into the id the page loads. A UUID is the id. Anything
 *   else is folded like typed input (`normaliseInputCode`: case, hyphens and Crockford look-alikes,
 *   so `2hx-9rb` is `2HX9RB`) and resolved as the scanner resolves a code: from the phone's
 *   snapshot first (`OfflineStore.byCode`, D120), then the server (`POST /scan/resolve`). A code
 *   that isn't a thing (or place) the person can see is not found, whatever the reason (D137).
 * - `useCanonicalAddress()` replaces the address in place (`replace: true`, so
 *   `history.replaceState` and no new history entry) with the short-ID form once the loaded row
 *   has one: a UUID link, or a code typed in lower case or with a hyphen.
 *
 * The short ID's own format never changes (D120, D208).
 */
import { isShortCode, normaliseInputCode } from '@kept/shared';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { captureApi } from '@/api/capture/queries';
import { ApiError } from '@/api/client';
import { currentOffline } from '@/offline/open';

export type AddressKind = 'thing' | 'place';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: string) => UUID.test(s);

/** The address a link uses: the short ID when there is one, else the id. */
export const addressOf = (row: { id: string; shortCode?: string | null }): string =>
  row.shortCode ?? row.id;

/** Codes already resolved in this tab (a canonical replace seeds it, so the page doesn't reload). */
const known = new Map<string, string>();
const keyOf = (kind: AddressKind, code: string) => `${kind}:${code}`;

/** Remembers that `code` is `id` (a row just loaded with its short ID). */
export function rememberAddress(kind: AddressKind, code: string, id: string): void {
  known.set(keyOf(kind, code), id);
}

/** The id a short ID stands for, or null when it is not a `kind` the person can see. */
export async function resolveAddress(kind: AddressKind, code: string): Promise<string | null> {
  const cached = known.get(keyOf(kind, code));
  if (cached) return cached;
  const offline = await currentOffline().catch(() => null);
  const hit = await offline?.store.byCode(code).catch(() => undefined);
  if (hit?.kind === kind && hit.id) {
    rememberAddress(kind, code, hit.id);
    return hit.id;
  }
  // Offline and not on this phone, this throws `offline`: the page says it can't load, with
  // Try again.
  const outcome = await captureApi.resolveScan({ text: code });
  if (outcome.outcome === 'open' && outcome.target.kind === kind) {
    rememberAddress(kind, code, outcome.target.id);
    return outcome.target.id;
  }
  return null;
}

export type Address =
  | { status: 'ready'; id: string }
  | { status: 'pending' }
  | { status: 'error'; error: unknown; retry: () => void };

const notFound = () => new ApiError(404, 'not_found', 'Not found');

/** The query that holds the id a short ID resolved to. */
const addressKey = (kind: AddressKind, code: string) => ['address', kind, code] as const;

/**
 * The id a route parameter names, if this tab already knows it: a UUID, or a short ID the page
 * (or the scanner) has resolved. Never a request: the sidebar reads it to follow the page.
 */
export function knownAddress(qc: QueryClient, kind: AddressKind, param: string): string | null {
  if (isUuid(param)) return param.toLowerCase();
  const code = normaliseInputCode(param);
  const cached = qc.getQueryData(addressKey(kind, code));
  return typeof cached === 'string' ? cached : (known.get(keyOf(kind, code)) ?? null);
}

/** The id a route parameter (a UUID or a short ID) names; see the header. */
export function useAddress(kind: AddressKind, param: string): Address {
  const uuid = isUuid(param);
  const code = uuid ? '' : normaliseInputCode(param);
  const query = useQuery({
    queryKey: addressKey(kind, code),
    queryFn: async () => {
      if (!isShortCode(code)) throw notFound();
      const id = await resolveAddress(kind, code);
      if (!id) throw notFound();
      return id;
    },
    enabled: !uuid,
    initialData: () => (uuid ? undefined : known.get(keyOf(kind, code))),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (uuid) return { status: 'ready', id: param.toLowerCase() };
  if (query.data) return { status: 'ready', id: query.data };
  if (query.isError)
    return { status: 'error', error: query.error, retry: () => void query.refetch() };
  return { status: 'pending' };
}

/**
 * Once the row is loaded: when it has a short ID and the address isn't exactly it, replace the
 * address in place, keeping the search (tab, sheet, list state).
 */
export function useCanonicalAddress(
  kind: AddressKind,
  param: string,
  row: { id: string; shortCode?: string | null } | undefined,
): void {
  const navigate = useNavigate();
  const shortCode = row?.shortCode ?? null;
  const id = row?.id;
  useEffect(() => {
    if (!shortCode || !id || param === shortCode) return;
    rememberAddress(kind, shortCode, id);
    void navigate({
      to: kind === 'thing' ? '/t/$id' : '/p/$id',
      params: { id: shortCode },
      search: ((prev: Record<string, unknown>) => prev) as never,
      replace: true,
    });
  }, [kind, param, shortCode, id, navigate]);
}

// ----- locations (1.1, D224) ------------------------------------------------------------------
// A location has no short ID; its address reads as its name, with the last 8 hex characters of
// its id to say which one: `/loc/garage-3f9c2a1b`. The tail resolves among the locations the
// person can see (the list the sidebar already loaded); the name part is for people, and is
// put right in place after a rename. A UUID still works, and is replaced by the readable form.

/** A location's name as an address part: letters and digits in any script, joined by hyphens. */
export function locationSlug(loc: { name: string; kind?: string }): string {
  const name = loc.kind === 'personal' ? 'personal' : loc.name;
  const slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'location';
}

const tailOf = (id: string) => id.replace(/-/g, '').slice(-8).toLowerCase();

/** The address a location's page reads as (an id that isn't a UUID, as in tests, is its own). */
export const locationAddress = (loc: { id: string; name: string; kind?: string }): string =>
  isUuid(loc.id) ? `${locationSlug(loc)}-${tailOf(loc.id)}` : loc.id;

/** The location id an address names, among `locations`; null when none (or, against the odds,
 * two) of them ends with its tail. */
export function locationIdOf(
  param: string,
  locations: readonly { id: string }[] | undefined,
): string | null | undefined {
  if (isUuid(param)) return param.toLowerCase();
  if (locations?.some((l) => l.id === param)) return param;
  const tail = /-([0-9a-f]{8})$/i.exec(param)?.[1]?.toLowerCase();
  if (!tail) return null;
  if (!locations) return undefined;
  const hits = locations.filter((l) => tailOf(l.id) === tail);
  return hits.length === 1 ? (hits[0] as { id: string }).id : null;
}

/** Once the location is loaded, its readable address replaces any other in place. */
export function useCanonicalLocationAddress(
  param: string,
  loc: { id: string; name: string; kind?: string } | undefined,
): void {
  const navigate = useNavigate();
  const target = loc ? locationAddress(loc) : null;
  useEffect(() => {
    if (!target || param === target) return;
    void navigate({
      to: '/loc/$id',
      params: { id: target },
      search: ((prev: Record<string, unknown>) => prev) as never,
      replace: true,
    });
  }, [param, target, navigate]);
}
