/**
 * The URL state of a contents list (`validateSearch` for its host route): the list keys, the
 * contents filters (CONTENTS_FILTERS), and `view`. Its own tiny module because a route's
 * `validateSearch` is not code-split: importing contents-list.tsx there would pull the whole
 * browse UI into the entry chunk (D80).
 */
import * as z from 'zod/mini';
import { listSearch } from '@/lib/url-state';

/** The filters every contents list reads from the URL (`f.state`, `f.where`, D205's type, tag,
 * brand and belongs-to, and "Imported by", step-7 T16). */
export const CONTENTS_FILTERS = [
  'state',
  'where',
  'type',
  'tag',
  'brand',
  'belongsTo',
  'importRun',
] as const;

/** `validateSearch` for a route that hosts a ContentsList: the list keys plus `view`. */
export const contentsSearch = listSearch(CONTENTS_FILTERS, {
  view: z.optional(z.catch(z.enum(['list', 'photos', 'grid']), 'list')),
});

const word = z.optional(z.catch(z.string(), ''));

/**
 * A location's page: the contents list's keys, `view` with the map (1.x, D237, M11) and the
 * spreadsheet (`table`, 1.x, D250), and the
 * map's own list: `find` (its search), `floor` (a floor's id, `_` for rooms on no floor), `show`
 * (`attention` for what needs it) and `debug` (`map` shows the map's measurements).
 */
export const locationSearch = listSearch(CONTENTS_FILTERS, {
  view: z.optional(z.catch(z.enum(['list', 'photos', 'grid', 'map', 'table']), 'list')),
  find: word,
  floor: word,
  show: z.optional(z.catch(z.enum(['room', 'attention']), 'room')),
  debug: word,
});
