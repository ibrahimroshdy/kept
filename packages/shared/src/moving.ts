// Moving mode (1.x, D39 (5), D251): packing a home into numbered boxes, carrying them, and
// unpacking them at the other end. A **move** belongs to the location being packed and may name
// the location it is going to; its **boxes** are ordinary Kept containers, each with a number in
// the move, a room it goes to, and where it is: packed, in transit or unpacked. The server, the
// web and the offline op share the vocabulary and the limits.

/** `moves.status`: a move is open until someone says it is done. */
export const MOVE_STATUSES = ['active', 'done'] as const;
export type MoveStatus = (typeof MOVE_STATUSES)[number];

/** `move_boxes.state`, in the order a box goes through them. */
export const BOX_STATES = ['packed', 'in_transit', 'unpacked'] as const;
export type BoxState = (typeof BOX_STATES)[number];

/** A move's name ("Flat to the new house"). */
export const MAX_MOVE_NAME = 200;
/** The word a new box is named with, before its number ("Box", "صندوق"). */
export const MAX_BOX_PREFIX = 40;
/** Boxes in one move. A whole house is a few hundred; the cap bounds the board and the PDF. */
export const MAX_MOVE_BOXES = 999;
/** Boxes one contents-sheet PDF prints. */
export const MAX_SHEET_BOXES = 200;
/** Lines one box's contents sheet prints; past it the sheet says how many more are in Kept. */
export const MAX_SHEET_LINES = 60;

/** Whether a box still has to arrive: not unpacked yet. */
export const isMissing = (state: BoxState): boolean => state !== 'unpacked';

/** A box's name from the move's word and its number: "Box 7". */
export const boxName = (prefix: string, n: number): string =>
  `${prefix.trim() || 'Box'} ${n}`.slice(0, 200);

/** The counts a board leads with. */
export type BoxCounts = Record<BoxState, number> & { total: number };

export function countBoxes(boxes: readonly { state: BoxState }[]): BoxCounts {
  const out: BoxCounts = { packed: 0, in_transit: 0, unpacked: 0, total: boxes.length };
  for (const b of boxes) out[b.state] += 1;
  return out;
}
