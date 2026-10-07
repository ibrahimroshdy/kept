/**
 * The search page's URL state (`validateSearch` for /search): the list keys and one `f.<name>`
 * per filter. Its own tiny module because a route's `validateSearch` is not code-split: importing
 * the search UI there would pull it into the entry chunk (D80).
 */
import { listSearch } from '@/lib/url-state';

/**
 * The search filters, as `f.<name>` URL keys (screens §5 Search). The price bounds and their
 * currency (`priceMin`, `priceMax`, `currency`) are offered only to people who can see money.
 */
export const SEARCH_FILTERS = [
  'location',
  'place',
  'type',
  'tag',
  'state',
  'priceMin',
  'priceMax',
  'currency',
] as const;

export const searchSearch = listSearch(SEARCH_FILTERS);
