import type { ActiveSourceType, OccurrenceKind } from '@kept/shared';
import type pg from 'pg';
import type { StaleMeter } from '../notify/words.js';
import type { ReminderItem, ReminderSubject } from './channel.js';

// An occurrence in words (L113): the thing (or place), where it is, the location, the local due
// date, the source's own name, and a deep link. Read as kept_system, whose SELECT-only policies
// (0053) reach every table used here; kept.path_of() is kept_app's, so the path is walked here,
// a level per query, capped at 64 as the SQL one is.

/** An occurrence row, as the scan and the deliver and digest jobs read it. */
export type OccurrenceRow = {
  id: string;
  location_id: string;
  thing_id: string | null;
  place_id: string | null;
  source_type: ActiveSourceType;
  source_id: string;
  kind: OccurrenceKind;
  due_period: string;
  due_on: string | null;
};

/** The columns of an OccurrenceRow, from `reminder_occurrences o`. */
export const OCCURRENCE_COLUMNS = `o.id, o.location_id, o.thing_id, o.place_id, o.source_type,
  o.source_id, o.kind, o.due_period, o.due_on::text AS due_on`;

/** The §7.13 key as the web's agenda and the push topic write it. */
export const occurrenceKey = (o: OccurrenceRow) =>
  `${o.source_type}:${o.source_id}:${o.kind}:${o.due_period}`;

const MAX_DEPTH = 64;

type ThingRow = {
  id: string;
  name: string | null;
  place_id: string | null;
  container_id: string | null;
};
type PlaceRow = { id: string; name: string; parent_id: string | null; is_unplaced: boolean };

/** Walks things (containers) and places up to their roots, fetching each level at once. */
async function loadTree(
  client: pg.ClientBase,
  thingIds: string[],
  placeIds: string[],
): Promise<{ things: Map<string, ThingRow>; places: Map<string, PlaceRow> }> {
  const things = new Map<string, ThingRow>();
  const places = new Map<string, PlaceRow>();
  let wantThings = [...new Set(thingIds)];
  let wantPlaces = [...new Set(placeIds)];
  for (let depth = 0; depth <= MAX_DEPTH && (wantThings.length || wantPlaces.length); depth++) {
    const nextThings: string[] = [];
    const nextPlaces: string[] = [];
    if (wantThings.length) {
      const { rows } = await client.query<ThingRow>(
        `SELECT id, name, place_id, container_id FROM public.things WHERE id = ANY($1::uuid[])`,
        [wantThings],
      );
      for (const r of rows) {
        things.set(r.id, r);
        if (r.container_id && !things.has(r.container_id)) nextThings.push(r.container_id);
        else if (!r.container_id && r.place_id && !places.has(r.place_id))
          nextPlaces.push(r.place_id);
      }
    }
    if (wantPlaces.length) {
      const { rows } = await client.query<PlaceRow>(
        `SELECT id, name, parent_id, is_unplaced FROM public.places WHERE id = ANY($1::uuid[])`,
        [wantPlaces],
      );
      for (const r of rows) {
        places.set(r.id, r);
        if (r.parent_id && !places.has(r.parent_id)) nextPlaces.push(r.parent_id);
      }
    }
    wantThings = [...new Set(nextThings)];
    wantPlaces = [...new Set(nextPlaces)];
  }
  return { things, places };
}

/** The places above `placeId`, root first, including it; the Unplaced area is left out (a thing
 * there is "in Home"). */
function placeChain(places: Map<string, PlaceRow>, placeId: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = placeId ? places.get(placeId) : undefined;
  while (cur && !seen.has(cur.id) && out.length < MAX_DEPTH) {
    seen.add(cur.id);
    if (!cur.is_unplaced) out.unshift(cur.name);
    cur = cur.parent_id ? places.get(cur.parent_id) : undefined;
  }
  return out;
}

/** Where a thing is: its place chain, then its containers, outermost first (not the thing). */
function thingChain(
  tree: { things: Map<string, ThingRow>; places: Map<string, PlaceRow> },
  thingId: string,
): string[] {
  const containers: string[] = [];
  const seen = new Set<string>();
  let cur = tree.things.get(thingId);
  while (cur?.container_id && !seen.has(cur.id) && containers.length < MAX_DEPTH) {
    seen.add(cur.id);
    const box = tree.things.get(cur.container_id);
    if (!box) break;
    containers.unshift(box.name ?? '');
    cur = box;
  }
  return [...placeChain(tree.places, cur?.place_id ?? null), ...containers];
}

type SourceWords = {
  title: string | null;
  warrantyKind: string | null;
  documentKind: string | null;
  loanDirection: 'out' | 'in' | null;
  unit: string | null;
  meter: { kind: StaleMeter['kind']; label: string | null; readOn: string | null } | null;
};

const NO_WORDS: SourceWords = {
  title: null,
  warrantyKind: null,
  documentKind: null,
  loanDirection: null,
  unit: null,
  meter: null,
};

/** Each source's own words: a schedule's name and meter unit, a warranty's provider and kind, a
 * document's title and kind, a loan's direction, a stale reading's meter. */
async function loadSources(
  client: pg.ClientBase,
  occurrences: readonly OccurrenceRow[],
): Promise<Map<string, SourceWords>> {
  const ids = (types: string[]) => [
    ...new Set(occurrences.filter((o) => types.includes(o.source_type)).map((o) => o.source_id)),
  ];
  const out = new Map<string, SourceWords>();
  const schedules = ids(['schedule']);
  if (schedules.length) {
    const { rows } = await client.query<{ id: string; name: string; unit: string | null }>(
      `SELECT s.id, s.name, m.unit FROM public.schedules s
         LEFT JOIN public.meters m ON m.id = s.meter_id
        WHERE s.id = ANY($1::uuid[])`,
      [schedules],
    );
    for (const r of rows) out.set(`schedule:${r.id}`, { ...NO_WORDS, title: r.name, unit: r.unit });
  }
  const warranties = ids(['warranty', 'registration']);
  if (warranties.length) {
    const { rows } = await client.query<{ id: string; kind: string; provider: string | null }>(
      'SELECT id, kind, provider FROM public.warranties WHERE id = ANY($1::uuid[])',
      [warranties],
    );
    for (const r of rows) {
      const words = { ...NO_WORDS, title: r.provider, warrantyKind: r.kind };
      out.set(`warranty:${r.id}`, words);
      out.set(`registration:${r.id}`, words);
    }
  }
  const documents = ids(['document']);
  if (documents.length) {
    const { rows } = await client.query<{ id: string; kind: string; title: string | null }>(
      'SELECT id, kind, title FROM public.expiring_documents WHERE id = ANY($1::uuid[])',
      [documents],
    );
    for (const r of rows)
      out.set(`document:${r.id}`, { ...NO_WORDS, title: r.title, documentKind: r.kind });
  }
  const loans = ids(['loan']);
  if (loans.length) {
    const { rows } = await client.query<{ id: string; direction: 'out' | 'in' }>(
      'SELECT id, direction FROM public.loans WHERE id = ANY($1::uuid[])',
      [loans],
    );
    for (const r of rows) out.set(`loan:${r.id}`, { ...NO_WORDS, loanDirection: r.direction });
  }
  const meters = ids(['reading_stale']);
  if (meters.length) {
    // The day it was last read, in the location's own zone: its latest accepted reading (the due
    // day can't say, as it rolls forward each period, 0089).
    const { rows } = await client.query<{
      id: string;
      kind: StaleMeter['kind'];
      label: string | null;
      unit: string;
      read_on: string | null;
    }>(
      `SELECT m.id, m.kind, m.label, m.unit,
              (SELECT (d.taken_at AT TIME ZONE l.timezone)::date::text
                 FROM public.meter_readings d
                WHERE d.meter_id = m.id AND d.state = 'accepted'
                ORDER BY d.taken_at DESC LIMIT 1) AS read_on
         FROM public.meters m JOIN public.locations l ON l.id = m.location_id
        WHERE m.id = ANY($1::uuid[])`,
      [meters],
    );
    for (const r of rows) {
      out.set(`reading_stale:${r.id}`, {
        ...NO_WORDS,
        title: r.label,
        unit: r.unit,
        meter: { kind: r.kind, label: r.label, readOn: r.read_on },
      });
    }
  }
  return out;
}

/** The page an occurrence opens: the thing (on its loans or schedules tab), the place, or the
 * location. `/t/<uuid>` and `/p/<uuid>` are accepted addresses (D208; the web swaps in the code). */
export function itemPath(
  o: Pick<OccurrenceRow, 'thing_id' | 'place_id' | 'location_id' | 'source_type'>,
): string {
  if (o.thing_id) {
    const tab =
      o.source_type === 'loan' ? 'loans' : o.source_type === 'schedule' ? 'schedules' : null;
    return `/t/${o.thing_id}${tab ? `?tab=${tab}` : ''}`;
  }
  if (o.place_id) return `/p/${o.place_id}`;
  return `/loc/${o.location_id}`;
}

/**
 * The words for each occurrence, in the order given. An occurrence whose location is gone is left
 * out (its row goes with the location's cascade anyway).
 */
export async function reminderItems(
  client: pg.ClientBase,
  occurrences: readonly OccurrenceRow[],
  publicUrl: string,
): Promise<ReminderItem[]> {
  if (occurrences.length === 0) return [];
  const locationIds = [...new Set(occurrences.map((o) => o.location_id))];
  const { rows: locations } = await client.query<{ id: string; name: string; timezone: string }>(
    'SELECT id, name, timezone FROM public.locations WHERE id = ANY($1::uuid[])',
    [locationIds],
  );
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const tree = await loadTree(
    client,
    occurrences.flatMap((o) => (o.thing_id ? [o.thing_id] : [])),
    occurrences.flatMap((o) => (o.place_id ? [o.place_id] : [])),
  );
  const sources = await loadSources(client, occurrences);
  const out: ReminderItem[] = [];
  for (const o of occurrences) {
    const location = locationById.get(o.location_id);
    if (!location) continue;
    let subject: ReminderSubject;
    if (o.thing_id) {
      subject = {
        type: 'thing',
        id: o.thing_id,
        name: tree.things.get(o.thing_id)?.name ?? '',
        path: thingChain(tree, o.thing_id),
      };
    } else if (o.place_id) {
      const place = tree.places.get(o.place_id);
      subject = {
        type: 'place',
        id: o.place_id,
        name: place?.name ?? '',
        path: placeChain(tree.places, place?.parent_id ?? null),
      };
    } else {
      subject = { type: 'location', id: location.id, name: location.name, path: [] };
    }
    const words = sources.get(`${o.source_type}:${o.source_id}`) ?? NO_WORDS;
    const meter = o.due_period.startsWith('meter:') ? o.due_period.slice(6) : null;
    out.push({
      occurrenceId: o.id,
      key: occurrenceKey(o),
      sourceType: o.source_type,
      sourceId: o.source_id,
      kind: o.kind,
      duePeriod: o.due_period,
      dueOn: o.due_on,
      dueValue: meter,
      unit: meter ? words.unit : null,
      title: words.title,
      warrantyKind: words.warrantyKind,
      documentKind: words.documentKind,
      loanDirection: words.loanDirection,
      ...(words.meter
        ? {
            meter: {
              kind: words.meter.kind,
              label: words.meter.label,
              readOn: words.meter.readOn,
            },
          }
        : {}),
      subject,
      location: { id: location.id, name: location.name, timezone: location.timezone },
      link: itemPath(o),
      url: new URL(itemPath(o), publicUrl).toString(),
    });
  }
  return out;
}
