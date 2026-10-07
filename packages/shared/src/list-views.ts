// The filter strip's saved views (D205): which lists can keep saved views, and which filters each
// list's views may hold. A saved view stores the list's URL state (SavedListQuery), not the
// server's query: a "Last 7 days" filter stays relative, and opening a view is putting its state
// back in the URL. The web's filter registry (apps/web/src/components/filters) and the server's
// saved-views validation (apps/server/src/search/saved-views.ts) both read these lists.

/** The lists that keep saved views (`saved_views.surface`). */
export const LIST_SURFACES = [
  'search',
  'activity',
  'trash',
  'things',
  'contents',
  'inbox',
  // Step 4 (D205 on every new list), and the AI call list (step-3 carry-over).
  'schedules',
  'lending',
  'paperwork',
  'expiring',
  'notifications',
  'incidents',
  'ai-calls',
  // Step 5: a vehicle's service records, the vehicles list, a vehicle's fills, a meter's readings.
  'services',
  'vehicles',
  'fuel',
  'readings',
] as const;
export type ListSurface = (typeof LIST_SURFACES)[number];

/**
 * The filter keys (`f.<key>` in the URL) a surface's saved views may hold.
 *
 * - search: location, place, type, tag, state, and the price range (money: MONEY_FILTER_KEYS).
 * - activity: location, person (`actor`), kind, date (`when`).
 * - trash: location, kind, deleted by (`by`), date (`when`).
 * - things (a person's, brand's or vendor's things): location, type, tag, state, brand, belongs to.
 * - contents (a location's, place's or container's contents): where (Unplaced), type, tag, state,
 *   brand, belongs to.
 * - inbox (screens §5, D175, D191): kind, location, and whose (`mine`: `everyone` for everyone's;
 *   absent is the default, Mine).
 * - schedules: location, state (upcoming, due, overdue), subject (thing or place), date (`when`).
 * - lending: location, direction (out, in), state (open, overdue, returned), person.
 * - paperwork: location, the attachment's role, subject, expiry.
 * - expiring: location, source (warranty, document, thing_expiry; schedule and loan when Home's
 *   overdue or due row opens it), state (Home's rows: overdue, due, expiring), date (`when`).
 * - notifications: kind, location, unread.
 * - incidents: location, kind, date (`when`).
 * - ai-calls (D206; the web's AI_CALL_FILTERS in components/ai/call-filters.tsx): date (`at`),
 *   person, location, task, model, provider, outcome, paid by, has image, tokens, cost and its
 *   currency (money: MONEY_FILTER_KEYS), thing.
 * - services (a thing's service records, step 5): date (`when`), vendor, line kind (`kind`),
 *   drafts (`draft`).
 * - vehicles (step 5, screens §1): location, type, state, reading (fresh, stale, unknown, none:
 *   `kept.meter_estimate().advice`), due (overdue, soon: from the agenda).
 * - fuel (a vehicle's fills and charges): date (`when`), unit, station (`vendor`), full or partial.
 * - readings (a meter's readings): date (`when`), source, state.
 */
export const SURFACE_FILTER_KEYS: Record<ListSurface, readonly string[]> = {
  search: ['location', 'place', 'type', 'tag', 'state', 'priceMin', 'priceMax', 'currency'],
  activity: ['location', 'actor', 'kind', 'when'],
  trash: ['location', 'kind', 'by', 'when'],
  things: ['location', 'type', 'tag', 'state', 'brand', 'belongsTo'],
  contents: ['where', 'type', 'tag', 'state', 'brand', 'belongsTo'],
  inbox: ['kind', 'location', 'mine'],
  schedules: ['location', 'state', 'subject', 'when'],
  lending: ['location', 'direction', 'state', 'person'],
  paperwork: ['location', 'role', 'subject', 'expiry'],
  expiring: ['location', 'source', 'state', 'when'],
  notifications: ['kind', 'location', 'unread'],
  incidents: ['location', 'kind', 'when'],
  'ai-calls': [
    'at',
    'person',
    'location',
    'task',
    'model',
    'provider',
    'outcome',
    'paidBy',
    'hasImage',
    'tokensMin',
    'tokensMax',
    'costMin',
    'costMax',
    'currency',
    'thing',
  ],
  services: ['when', 'vendor', 'kind', 'draft'],
  vehicles: ['location', 'type', 'state', 'reading', 'due'],
  fuel: ['when', 'unit', 'vendor', 'full'],
  readings: ['when', 'source', 'state'],
};

/** Filter keys that carry money: a view holding one is withheld where money is hidden. */
export const MONEY_FILTER_KEYS = [
  'priceMin',
  'priceMax',
  'costMin',
  'costMax',
  'currency',
] as const;

/** The most values one filter may hold (URL, saved view and list endpoints alike). */
export const MAX_FILTER_VALUES = 50;

/** The most views one person may pin on one list. */
export const MAX_PINNED_VIEWS = 20;

/**
 * A saved view's query: the list state it puts back in the URL. `filters` maps a filter key to
 * its values; `not` names the filters that are "is none of" rather than "is any of".
 */
export type SavedListQuery = {
  q?: string;
  filters?: Record<string, string[]>;
  not?: string[];
  group?: string;
  sort?: string;
  /** The sort turned around (D211); absent, the sort's own order (A to Z, newest first). */
  dir?: 'asc' | 'desc';
  /** The list's layout where it offers one (D211: `photos` for a container's contents). */
  layout?: string;
};

/** Date filter presets (`f.when=week`); anything else is a custom range `YYYY-MM-DD..YYYY-MM-DD`
 * (either end may be empty: `2026-09-01..`). */
export const DATE_PRESETS = ['today', 'week', 'month', 'year'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A custom date range value's two days (`null` for an open end), or null when malformed. */
export function parseDateRange(value: string): { from: string | null; to: string | null } | null {
  const parts = value.split('..');
  if (parts.length !== 2) return null;
  const [from, to] = parts as [string, string];
  if ((from && !DAY.test(from)) || (to && !DAY.test(to)) || (!from && !to)) return null;
  if (from && to && from > to) return null;
  return { from: from || null, to: to || null };
}

/** A date filter value is a preset or a well-formed custom range. */
export const isDateFilterValue = (value: string): boolean =>
  (DATE_PRESETS as readonly string[]).includes(value) || parseDateRange(value) !== null;
