/**
 * Read-only share links (D39 item 7, D72, D116, D180; engineering spec §1 `share_links`, §3.2,
 * §3.3; D233). A location's owner or admin shares a box (a thing), a place or a filtered list as
 * an expiring link that opens with no account. The page shows a fixed whitelist only: name,
 * photo, type, place path, quantity, condition, description. Never money, secrets, serials,
 * people, loan details or documents.
 */

/** `share_links.scope_type`: a thing (a box and what's in it), a place, or a filtered list. */
export const SHARE_LINK_SCOPES = ['thing', 'place', 'view'] as const;
export type ShareLinkScope = (typeof SHARE_LINK_SCOPES)[number];

/** The expiry choices, in days (§3.3: default 30, at most a year). */
export const SHARE_LINK_EXPIRY_DAYS = [1, 7, 30, 90, 365] as const;
export const SHARE_LINK_DEFAULT_DAYS = 30;
export const SHARE_LINK_MAX_DAYS = 365;

/** Live links (not revoked, not expired) a location may have at once. */
export const MAX_LIVE_SHARE_LINKS = 100;

/** A link's token: 32 random bytes, base64url (43 characters), shown once and stored hashed. */
export const SHARE_LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Things per page of a shared page, and the most a link shows in all (D72's size cap). */
export const SHARE_LINK_PAGE_SIZE = 60;
export const SHARE_LINK_MAX_ITEMS = 1200;

/** Page views a minute, per link (§3.2). */
export const SHARE_LINK_VIEWS_PER_MINUTE = 60;

/**
 * Where a link stands, for its list: `stopped` when its creator no longer administers the
 * location (D180; it comes back if they do again before it expires).
 */
export const SHARE_LINK_STATES = ['active', 'expired', 'revoked', 'stopped'] as const;
export type ShareLinkState = (typeof SHARE_LINK_STATES)[number];

/** The list filters a shared list keeps: words, and places, types and tags (any of, none of). */
export const SHARE_VIEW_FILTERS = ['place', 'type', 'tag'] as const;
export type ShareViewFilter = (typeof SHARE_VIEW_FILTERS)[number];

/** A shared list: the words and the filters it keeps, evaluated when the page opens. */
export type ShareView = {
  q?: string;
  filters?: Partial<Record<ShareViewFilter, string[]>>;
  /** The filters that are "is none of" rather than "is any of". */
  not?: ShareViewFilter[];
};

/**
 * A search's list state as a shared list: the filters a link keeps, the one location it must name,
 * and the filters it can't keep (state and price would say what is lent, in repair or worth what;
 * a link names one location, never "none of"). A list with `unsupported` filters isn't shared:
 * the person removes them first, so the link never shows more than the list did.
 */
export function shareViewOf(list: {
  q?: string;
  filters?: Record<string, string[] | undefined>;
  not?: string[];
}): { view: ShareView; locationId: string | null; unsupported: string[] } {
  const filters: Partial<Record<ShareViewFilter, string[]>> = {};
  const not: ShareViewFilter[] = [];
  const unsupported: string[] = [];
  let locationId: string | null = null;
  const negated = new Set(list.not ?? []);
  for (const [key, values] of Object.entries(list.filters ?? {})) {
    if (!values || values.length === 0) continue;
    if (key === 'location') {
      if (values.length === 1 && !negated.has(key)) locationId = values[0] ?? null;
      else unsupported.push(key);
      continue;
    }
    if ((SHARE_VIEW_FILTERS as readonly string[]).includes(key)) {
      const k = key as ShareViewFilter;
      filters[k] = [...values];
      if (negated.has(k)) not.push(k);
      continue;
    }
    unsupported.push(key);
  }
  const q = list.q?.trim();
  const view: ShareView = {
    ...(q ? { q } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(not.length ? { not } : {}),
  };
  return { view, locationId, unsupported: [...new Set(unsupported)].sort() };
}
