import { type BoxState, type Digits, MAX_SHEET_BOXES, MAX_SHEET_LINES } from '@kept/shared';
import type pg from 'pg';
import { notFound } from '../../http/errors.js';
import type { ReportLocale } from '../labels.js';

// What a move's contents sheets hold (1.x, D251): one page per box, read in the requester's scope
// (the `report` job runs as a tenant job on kept_app, so row-level security decides what it can
// see, as for a request). Each box: its number, name and short ID (its QR code: scanning the sheet
// opens the box, as its label does), the room it goes to, and what is directly inside it (a box
// inside is one line, with how many things it holds). A box the requester can't see any more
// (unpacked into a location they aren't in) is left out. At most MAX_SHEET_BOXES boxes and
// MAX_SHEET_LINES lines a box; past that a sheet says how many more are in Kept.

export type MoveReportOptions = {
  kind: 'move';
  moveId: string;
  /** Only these boxes (containers), in number order; null: every box of the move. */
  containerIds: string[] | null;
  locale: ReportLocale;
  digits: Digits;
};

export type GatheredLine = {
  name: string;
  quantity: string;
  shortCode: string | null;
  /** For a box inside: how many things it holds. */
  inside: number | null;
};

export type GatheredBox = {
  containerId: string;
  number: number;
  name: string;
  shortCode: string | null;
  state: BoxState;
  room: string | null;
  lines: GatheredLine[];
  moreLines: number;
};

export type GatheredMove = {
  name: string;
  locationName: string;
  toLocationName: string | null;
  requesterName: string;
  requesterTimezone: string;
  boxes: GatheredBox[];
};

/** Everything the sheets print, as the requester may see it. 404 for a move they can't see. */
export async function gatherMove(
  client: pg.ClientBase,
  options: MoveReportOptions,
): Promise<GatheredMove> {
  const { rows: moves } = await client.query<{
    name: string;
    location_name: string;
    to_name: string | null;
  }>(
    `SELECT m.name, l.name AS location_name,
            (SELECT tl.name FROM public.locations tl
              WHERE tl.id = m.to_location_id AND tl.deleted_at IS NULL) AS to_name
       FROM public.moves m JOIN public.locations l ON l.id = m.location_id
      WHERE m.id = $1`,
    [options.moveId],
  );
  const move = moves[0];
  if (!move) throw notFound();

  const { rows: boxes } = await client.query<{
    container_id: string;
    number: number;
    state: BoxState;
    name: string | null;
    room: string | null;
    short_code: string | null;
  }>(
    `SELECT b.container_id, b.number, b.state, t.name, d.name AS room,
            (SELECT s.code FROM public.short_ids s
              WHERE s.thing_id = b.container_id AND s.is_primary AND s.state = 'assigned'
              LIMIT 1) AS short_code
       FROM public.move_boxes b
       JOIN public.things t ON t.id = b.container_id AND t.deleted_at IS NULL
       LEFT JOIN public.places d ON d.id = b.destination_place_id AND d.deleted_at IS NULL
      WHERE b.move_id = $1 AND ($2::uuid[] IS NULL OR b.container_id = ANY ($2::uuid[]))
      ORDER BY b.number
      LIMIT ${MAX_SHEET_BOXES}`,
    [options.moveId, options.containerIds],
  );
  const ids = boxes.map((b) => b.container_id);
  const { rows: lines } = await client.query<{
    container_id: string;
    name: string | null;
    quantity: string;
    short_code: string | null;
    inside: number | null;
    n: number;
  }>(
    `SELECT * FROM (
       SELECT c.container_id, c.name, c.quantity::text AS quantity,
              (SELECT s.code FROM public.short_ids s
                WHERE s.thing_id = c.id AND s.is_primary AND s.state = 'assigned' LIMIT 1)
                AS short_code,
              (SELECT nullif(count(*), 0)::int FROM public.things g
                WHERE g.container_id = c.id AND g.deleted_at IS NULL) AS inside,
              row_number() OVER (PARTITION BY c.container_id
                                 ORDER BY lower(coalesce(c.name, '')), c.id)::int AS n
         FROM public.things c
        WHERE c.container_id = ANY ($1::uuid[]) AND c.deleted_at IS NULL
     ) x
     ORDER BY x.container_id, x.n`,
    [ids],
  );
  const byBox = new Map<string, typeof lines>();
  for (const l of lines) {
    const list = byBox.get(l.container_id) ?? [];
    list.push(l);
    byBox.set(l.container_id, list);
  }
  const { rows: me } = await client.query<{ display_name: string; timezone: string }>(
    'SELECT display_name, timezone FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  return {
    name: move.name,
    locationName: move.location_name,
    toLocationName: move.to_name,
    requesterName: me[0]?.display_name ?? '',
    requesterTimezone: me[0]?.timezone ?? 'UTC',
    boxes: boxes.map((b) => {
      const all = byBox.get(b.container_id) ?? [];
      return {
        containerId: b.container_id,
        number: b.number,
        name: b.name ?? '',
        shortCode: b.short_code,
        state: b.state,
        room: b.room,
        lines: all.slice(0, MAX_SHEET_LINES).map((l) => ({
          name: l.name ?? '',
          quantity: l.quantity,
          shortCode: l.short_code,
          inside: l.inside,
        })),
        moreLines: Math.max(0, all.length - MAX_SHEET_LINES),
      };
    }),
  };
}
