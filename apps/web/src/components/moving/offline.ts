/**
 * Moving mode on a phone with no signal (1.x, D251; D17, D35). In the middle of a move the van,
 * the stairwell and the new house's basement often have none, so the board and its boxes work
 * offline:
 *
 * - **Reading.** Every board the phone opens online is remembered in its offline database (meta
 *   `moves`; a 401 clears it with the rest of the cache, wipe.ts). Offline, the board is that copy
 *   ("as of" the time it was read), with the box changes still queued on this phone laid over it.
 *   What is inside a box comes from the phone's snapshot, like the box check's (boxcheck/load.ts).
 * - **Writing.** Marking a box packed or in transit, and unpacking it into a room, are the
 *   `move_box` op: online they go straight to the server (with Undo from the toast); offline, or
 *   when the call can't reach it, they wait in the queue and the board shows them at once.
 *   Packing is the ordinary `move` op (the carrying tray, or Move on a thing). Starting a move,
 *   adding a box (its number comes from the server), choosing a box's room, the contents sheets
 *   and finishing a move need a connection.
 * - **Conflicts.** The server orders box changes by when they happened on each phone: a change
 *   older than the box's last one changes nothing (the newer word stands, and the board shows it
 *   after the next sync). An unpack into a room someone trashed meanwhile is dropped with a notice
 *   and a restore, like any op (D35).
 */
import type { BoxState } from '@kept/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { isApiError } from '@/api/client';
import { movingApi, movingKeys } from '@/api/moving/queries';
import type { Move, MoveBox } from '@/api/moving/types';
import { queueItem } from '@/components/scan/resolve';
import type { OfflineStore, QueueEntry } from '@/offline/store';

/** What the board shows, and where it came from. */
export type Board = { move: Move; from: 'server' | 'phone'; asOf: string | null };

type Remembered = Record<string, { move: Move; at: string }>;

/** The store's meta table, where the phone has one (DexieStore); a page store has none. */
type MetaStore = {
  meta: (key: 'moves') => Promise<unknown>;
  setMeta: (key: 'moves', value: unknown) => Promise<void>;
};

const metaOf = (store: OfflineStore | null): MetaStore | null => {
  const m = store as Partial<Record<keyof MetaStore, unknown>> | null;
  return m && typeof m.meta === 'function' && typeof m.setMeta === 'function'
    ? (m as unknown as MetaStore)
    : null;
};

/** A page without an offline database (tests, a browser with none) keeps them in memory. */
const inMemory: Remembered = {};

/** At most this many boards are kept: the moves in progress, newest first. */
const KEEP = 5;

async function readAll(store: OfflineStore | null): Promise<Remembered> {
  const m = metaOf(store);
  if (!m) return inMemory;
  try {
    return ((await m.meta('moves')) as Remembered | undefined) ?? {};
  } catch {
    return {};
  }
}

/** Keeps `move` for offline use. Never throws: a full disk only loses the copy. */
export async function rememberMove(store: OfflineStore | null, move: Move): Promise<void> {
  const all = { ...(await readAll(store)), [move.id]: { move, at: new Date().toISOString() } };
  const kept = Object.fromEntries(
    Object.entries(all)
      .sort(([, a], [, b]) => b.at.localeCompare(a.at))
      .slice(0, KEEP),
  );
  const m = metaOf(store);
  if (!m) {
    for (const k of Object.keys(inMemory)) delete inMemory[k];
    Object.assign(inMemory, kept);
    return;
  }
  await m.setMeta('moves', kept).catch(() => {});
}

export async function rememberedMove(
  store: OfflineStore | null,
  id: string,
): Promise<{ move: Move; at: string } | null> {
  return (await readAll(store))[id] ?? null;
}

/** The moves this phone remembers, for the list offline. */
export async function rememberedMoves(store: OfflineStore | null): Promise<Move[]> {
  return Object.values(await readAll(store)).map((r) => r.move);
}

/** The `move_box` ops still waiting on this phone, in queue order. */
async function waiting(store: OfflineStore | null): Promise<QueueEntry[]> {
  if (!store) return [];
  return (await store.pending()).filter((e) => e.op === 'move_box');
}

type BoxPayload = { moveId: string; containerId: string; state: BoxState; placeId?: string };

/** The board with this phone's queued box changes laid over it. */
export function overlay(move: Move, ops: readonly QueueEntry[]): Move {
  const boxes = move.boxes.map((b) => {
    let out = b;
    for (const e of ops) {
      const p = e.payload as BoxPayload;
      if (p.moveId !== move.id || p.containerId !== b.containerId) continue;
      out = {
        ...out,
        state: p.state,
        stateAt: e.takenAt,
        ...(p.state === 'unpacked' && p.placeId ? { placeId: p.placeId } : {}),
      };
    }
    return out;
  });
  const counts = { packed: 0, in_transit: 0, unpacked: 0, total: boxes.length };
  for (const b of boxes) counts[b.state] += 1;
  return { ...move, boxes, counts };
}

/** The ids of the boxes with a change still waiting on this phone. */
export async function waitingBoxes(store: OfflineStore | null): Promise<Set<string>> {
  return new Set((await waiting(store)).map((e) => (e.payload as BoxPayload).containerId));
}

/** Loads a board: the server when online (and remembers it), else the phone's copy. */
export async function loadBoard(
  id: string,
  { store, online }: { store: OfflineStore | null; online: boolean },
): Promise<Board | null> {
  let board: Board | null = null;
  if (online) {
    try {
      const move = await movingApi.move(id);
      await rememberMove(store, move);
      board = { move, from: 'server', asOf: null };
    } catch (e) {
      if (!(isApiError(e) && e.code === 'offline')) throw e;
    }
  }
  if (!board) {
    const kept = await rememberedMove(store, id);
    if (!kept) return null;
    board = { move: kept.move, from: 'phone', asOf: kept.at };
  }
  return { ...board, move: overlay(board.move, await waiting(store)) };
}

export function useBoard(
  id: string,
  { store, online }: { store: OfflineStore | null; online: boolean },
) {
  return useQuery({
    queryKey: [...movingKeys.one(id), online ? 'online' : 'offline'],
    queryFn: () => loadBoard(id, { store, online }),
    retry: false,
  });
}

export type BoxWritten =
  | { via: 'server'; box: MoveBox; auditEvents: string[] }
  /** The op's idempotency key: Undo takes it back out of the queue while it is unsent. */
  | { via: 'queue'; key: string };

/**
 * A box's new state (and, to unpack, its room): to the server when it can be reached, else the
 * `move_box` op in the queue.
 */
export async function setBoxState({
  store,
  online,
  move,
  box,
  state,
  placeId,
}: {
  store: OfflineStore | null;
  online: boolean;
  move: Pick<Move, 'id' | 'locationId'>;
  box: Pick<MoveBox, 'containerId'>;
  state: BoxState;
  placeId?: string | undefined;
}): Promise<BoxWritten> {
  if (online) {
    try {
      const w =
        state === 'unpacked'
          ? await movingApi.unpack(move.id, box.containerId, placeId ? { placeId } : {})
          : await movingApi.updateBox(move.id, box.containerId, { state });
      return { via: 'server', box: w.body, auditEvents: w.auditEvents };
    } catch (e) {
      if (!(isApiError(e) && e.code === 'offline') || !store) throw e;
    }
  }
  if (!store) throw new Error('No offline store to queue the change in.');
  const item = queueItem('move_box', move.locationId, {
    moveId: move.id,
    containerId: box.containerId,
    state,
    ...(placeId ? { placeId } : {}),
  });
  await store.enqueue(item, []);
  return { via: 'queue', key: item.idempotencyKey };
}

/** After a box change: the board and the box's contents read again. */
export function useRefreshBoard() {
  const qc = useQueryClient();
  return useCallback(
    (moveId: string) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: movingKeys.one(moveId) }),
        qc.invalidateQueries({ queryKey: movingKeys.all }),
      ]),
    [qc],
  );
}
