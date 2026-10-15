/**
 * Moving mode's contract (1.x, D39 (5), D251), after `apps/server/src/moving/service.ts`.
 *
 * A move belongs to the location being packed and may name the location it is going to
 * (`toLocationId`; null when the boxes stay in this location). Its boxes are ordinary containers,
 * each with its number in the move, the room it goes to (`destination`) and its state: packed →
 * in transit → unpacked. Unpacking moves the box, with everything inside it, into its room.
 * Everyone who sees the location reads its moves; members and above pack, mark and unpack. A move
 * marked done takes no box changes until it is opened again (409 `conflict`,
 * `reason: 'move_done'`).
 */
import type { BoxCounts, BoxState, MoveStatus } from '@kept/shared';

export type { BoxCounts, BoxState, MoveStatus };

type Person = { displayName: string };

export type MoveRow = {
  id: string;
  locationId: string;
  toLocationId: string | null;
  /** Null when you can't see that location. */
  toLocationName: string | null;
  name: string;
  status: MoveStatus;
  createdBy: Person;
  createdAt: string;
  finishedAt: string | null;
  counts: BoxCounts;
  rowVersion: number;
};

export type MoveBox = {
  moveId: string;
  containerId: string;
  number: number;
  state: BoxState;
  stateAt: string;
  stateBy: Person | null;
  /** False when the box is somewhere you can't see (unpacked into a location you aren't in). */
  visible: boolean;
  name: string | null;
  shortCode: string | null;
  /** Where the box is now. */
  locationId: string | null;
  placeId: string | null;
  /** "Kitchen › Shelf". */
  where: string | null;
  /** Things directly inside it. */
  contents: number;
  destination: { placeId: string; name: string; locationId: string } | null;
  rowVersion: number;
};

export type Move = MoveRow & { boxes: MoveBox[] };

/** GET /api/v1/move-boxes/:containerId: a scanned container's box, and its move. */
export type BoxOfContainer = MoveBox & { move: { id: string; name: string; status: MoveStatus } };

/** GET /api/v1/moves. */
export type MovesParams = {
  locationId?: string;
  status?: MoveStatus;
  limit?: number;
  cursor?: string;
};

export type CreateMoveBody = { id?: string; name: string; toLocationId?: string };
export type UpdateMoveBody = {
  name?: string;
  toLocationId?: string | null;
  status?: MoveStatus;
};
export type AddBoxBody =
  | { containerId: string; destinationPlaceId?: string }
  | {
      new: { id?: string; prefix?: string; placeId?: string };
      destinationPlaceId?: string;
    };
export type UpdateBoxBody = { state?: BoxState; destinationPlaceId?: string | null };
export type UnpackBody = { placeId?: string };

/** POST /api/v1/reports/move: a page per box, or only these boxes. */
export type ContentsSheetsBody = {
  moveId: string;
  containerIds?: string[];
  locale?: 'en' | 'ar';
  digits?: 'western' | 'eastern';
};
