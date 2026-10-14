// Renters' condition reports (1.x, D171, D174; D235): a move-in or move-out walk-through of one
// location, room by room, each room with a condition, a note and dated photos. The server and the
// web share the vocabulary, the limits and how two reports' rooms are paired for a comparison.

/** `condition_reports.kind`. */
export const CONDITION_REPORT_KINDS = ['move_in', 'move_out'] as const;
export type ConditionReportKind = (typeof CONDITION_REPORT_KINDS)[number];

/** `condition_report_rooms.condition`: how the room was found; null until someone says. */
export const ROOM_CONDITIONS = ['good', 'fair', 'poor', 'damaged'] as const;
export type RoomCondition = (typeof ROOM_CONDITIONS)[number];

/** Rooms in one report. A home has a dozen; the cap bounds the page and the PDF. */
export const MAX_CONDITION_ROOMS = 40;
/** Photos on one room of one report. */
export const MAX_ROOM_PHOTOS = 12;
/** Photos one PDF prints (a comparison counts both sides); past it a room says how many more are
 * in Kept, as the vehicle report does with its proof photos. */
export const MAX_CONDITION_PDF_PHOTOS = 240;
/** A report's notes and a room's note. */
export const MAX_CONDITION_NOTE = 4000;
/** A room's name. */
export const MAX_ROOM_NAME = 200;

/** The other kind: what a report is compared with. */
export const otherConditionKind = (kind: ConditionReportKind): ConditionReportKind =>
  kind === 'move_in' ? 'move_out' : 'move_in';

/** What pairing reads of a room. */
export type PairableRoom = { id: string; placeId: string | null; name: string };

/** A pair of rooms, one from each report; either side is null when the other report has no such
 * room. */
export type RoomPair<A, B> = { a: A | null; b: B | null };

const nameKey = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Pairs `a`'s rooms with `b`'s for a side-by-side comparison: by place first (the same place in
 * both reports), then by name (a room added by hand, or one whose place was since deleted), each
 * room used once. The order is `a`'s, then `b`'s rooms that have no partner, in `b`'s order.
 */
export function pairRooms<A extends PairableRoom, B extends PairableRoom>(
  a: readonly A[],
  b: readonly B[],
): RoomPair<A, B>[] {
  const used = new Set<string>();
  const byPlace = new Map<string, B>();
  for (const r of b) if (r.placeId && !byPlace.has(r.placeId)) byPlace.set(r.placeId, r);
  const partner = new Map<string, B>();
  for (const r of a) {
    const m = r.placeId ? byPlace.get(r.placeId) : undefined;
    if (m && !used.has(m.id)) {
      used.add(m.id);
      partner.set(r.id, m);
    }
  }
  for (const r of a) {
    if (partner.has(r.id)) continue;
    const key = nameKey(r.name);
    const m = b.find((x) => !used.has(x.id) && nameKey(x.name) === key);
    if (m) {
      used.add(m.id);
      partner.set(r.id, m);
    }
  }
  return [
    ...a.map((r) => ({ a: r, b: partner.get(r.id) ?? null })),
    ...b.filter((r) => !used.has(r.id)).map((r) => ({ a: null, b: r })),
  ];
}
