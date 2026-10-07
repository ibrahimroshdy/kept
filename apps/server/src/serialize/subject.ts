import { z } from 'zod';

// SubjectRef (web contract: apps/web/src/api/household/types.ts): what a schedule, a service
// record, a loan, a document or a notification is about (a thing, a place, or a location itself;
// D39, D155), with where it is. One set of SQL builders for every module that returns one, so a
// path reads the same on the Schedules, Lending, Paperwork and Expiring screens.

export type SubjectRef = {
  type: 'thing' | 'place' | 'location';
  id: string;
  name: string;
  /** "Home › Kitchen › Drawer": the location, then the places and containers above it; empty
   * for a location. */
  path: string;
  shortCode?: string | null;
};

export const SubjectRefSchema = z.object({
  type: z.enum(['thing', 'place', 'location']),
  id: z.uuid(),
  name: z.string(),
  path: z.string(),
  shortCode: z.string().nullable().optional(),
});

/** The separator of a subject's path (the mock's, apps/web/src/api/household/mock/db.ts). */
export const PATH_SEPARATOR = ' › ';

/** SQL: the names of the places and containers from `place` down to `container` (a
 * `kept.path_of()` walk), joined; an unnamed step is left out, and so is the Unplaced area: its
 * stored name is English and the reader's client can't tell it from a place called that, so a
 * thing waiting there reads as in its location (as the reminders' paths do, reminders/items.ts;
 * UI step-4 review L2). */
const stepsSql = (place: string, container: string) => `(
  SELECT string_agg(e->>'name', '${PATH_SEPARATOR}' ORDER BY n)
    FROM jsonb_array_elements(kept.path_of(${place}, ${container})) WITH ORDINALITY AS x(e, n)
   WHERE NOT (e->>'kind' = 'place' AND EXISTS (
           SELECT 1 FROM public.places up WHERE up.id = (e->>'id')::uuid AND up.is_unplaced)))`;

/** SQL: the primary short ID of the thing or place whose id is `id`. */
const primaryCodeSql = (column: 'thing_id' | 'place_id', id: string) =>
  `(SELECT sc.code FROM public.short_ids sc
     WHERE sc.${column} = ${id} AND sc.is_primary AND sc.state = 'assigned' LIMIT 1)`;

/** SQL: the SubjectRef (jsonb) of the thing row aliased `t`, in the location named `location`
 * (a SQL expression). Its path runs through the places and containers it is in. */
export const thingSubjectJson = (t: string, location: string) => `jsonb_build_object(
  'type', 'thing', 'id', ${t}.id, 'name', coalesce(${t}.name, ''),
  'path', concat_ws('${PATH_SEPARATOR}', ${location}, ${stepsSql(`${t}.place_id`, `${t}.container_id`)}),
  'shortCode', ${primaryCodeSql('thing_id', `${t}.id`)})`;

/** SQL: the SubjectRef (jsonb) of the place row aliased `p`, in the location named `location`:
 * its path runs through the places above it. */
export const placeSubjectJson = (p: string, location: string) => `jsonb_build_object(
  'type', 'place', 'id', ${p}.id, 'name', ${p}.name,
  'path', concat_ws('${PATH_SEPARATOR}', ${location}, ${stepsSql(`${p}.parent_id`, 'NULL::uuid')}),
  'shortCode', ${primaryCodeSql('place_id', `${p}.id`)})`;
