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
  view: z.optional(z.catch(z.enum(['list', 'photos']), 'list')),
});
