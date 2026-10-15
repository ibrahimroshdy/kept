/**
 * Moving mode offline (1.x, D251): the board is remembered when read online and read back from
 * the phone without signal; a box change goes to the server when it can and waits in the queue
 * as a `move_box` op when it can't, shown on the board at once; an unpack waiting on the phone
 * shows the box in its room.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { createMockApi } from '@/api/mock/server';
import { seedMove } from '@/api/moving/mock';
import { applyOptimistic, MemoryStore } from '@/offline/store';
import { loadBoard, overlay, rememberedMove, setBoxState } from './offline';

const MOVE = '01926f00-0000-7000-8000-0000000mv101';
const T = INV_IDS.thing;
const P = INV_IDS.place;

function online() {
  const state = ownerScenario();
  for (const l of state.locations) if (l.id === IDS.home) l.modules.push('moving');
  seedMove(state, {
    id: MOVE,
    locationId: IDS.home,
    toLocationId: null,
    name: 'Clear-out',
    status: 'active',
    createdBy: { displayName: 'Ibrahim' },
    createdAt: '2026-10-10T09:00:00Z',
    finishedAt: null,
    rowVersion: 1,
    boxes: [
      {
        containerId: T.box3,
        number: 1,
        state: 'packed',
        stateAt: '2026-10-10T09:05:00Z',
        stateBy: null,
        destinationPlaceId: P.kitchen,
        rowVersion: 1,
      },
    ],
  });
  vi.stubGlobal('fetch', createMockApi(state).fetch);
  return state;
}

/** No signal: every request fails before it reaches anything. */
const offline = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  );

afterEach(() => vi.unstubAllGlobals());

describe('the board offline', () => {
  it('remembers a board read online, and reads it back without signal', async () => {
    online();
    const store = new MemoryStore();
    const fresh = await loadBoard(MOVE, { store, online: true });
    expect(fresh).toMatchObject({ from: 'server', asOf: null });
    expect(fresh?.move.boxes[0]?.name).toBe('Box 3');
    expect((await rememberedMove(store, MOVE))?.move.name).toBe('Clear-out');

    offline();
    const kept = await loadBoard(MOVE, { store, online: true });
    expect(kept?.from).toBe('phone');
    expect(kept?.asOf).toBeTruthy();
    expect(kept?.move.boxes[0]?.state).toBe('packed');
    expect(await loadBoard('01926f00-0000-7000-8000-0000000mv999', { store, online: false })).toBe(
      null,
    );
  });

  it('a box change goes to the server online, and waits in the queue offline, shown at once', async () => {
    const state = online();
    const store = new MemoryStore();
    const board = await loadBoard(MOVE, { store, online: true });
    const move = board?.move as NonNullable<typeof board>['move'];
    const box = move.boxes[0] as (typeof move.boxes)[number];

    const sent = await setBoxState({ store, online: true, move, box, state: 'in_transit' });
    expect(sent.via).toBe('server');
    expect(sent.via === 'server' && sent.auditEvents.length).toBe(1);
    // The board reads itself again after a change (useRefreshBoard), and remembers that.
    await loadBoard(MOVE, { store, online: true });

    offline();
    const queued = await setBoxState({
      store,
      online: true,
      move,
      box,
      state: 'unpacked',
      placeId: P.kitchen,
    });
    expect(queued.via).toBe('queue');
    const [op] = await store.pending();
    expect(op).toMatchObject({
      op: 'move_box',
      locationId: IDS.home,
      payload: { moveId: MOVE, containerId: T.box3, state: 'unpacked', placeId: P.kitchen },
    });
    const shown = await loadBoard(MOVE, { store, online: false });
    expect(shown?.move.boxes[0]).toMatchObject({ state: 'unpacked', placeId: P.kitchen });
    expect(shown?.move.counts).toMatchObject({ unpacked: 1, packed: 0, in_transit: 0 });
    // The server never saw it.
    expect(state.inventory.things.find((t) => t.id === T.box3)?.placeId).not.toBe(P.kitchen);

    // Taken back while it waits: the board is as it was.
    if (queued.via === 'queue') await store.unqueue([queued.key]);
    expect((await loadBoard(MOVE, { store, online: false }))?.move.boxes[0]?.state).toBe(
      'in_transit',
    );
  });

  it('an unpack waiting on the phone shows the box in its room in the snapshot', () => {
    const rows = new Map([
      [
        T.box3,
        {
          id: T.box3,
          locationId: IDS.home,
          shortCode: 'B0X3AA',
          name: 'Box 3',
          typeId: null,
          placeId: P.hallwayCloset,
          containerId: null,
          quantity: '1',
          aliases: {},
          lifecycle: 'in_use' as const,
          reviewState: 'confirmed' as const,
          locationUncertain: false,
          lastSeenAt: null,
          coverFileId: null,
          isContainer: true,
          deleted: false,
        },
      ],
    ]);
    applyOptimistic(rows, {
      clientVersion: '1',
      payloadVersion: 1,
      clientId: '01926f00-0000-7000-8000-0000000mv201',
      idempotencyKey: 'move_box:1',
      op: 'move_box',
      takenAt: new Date().toISOString(),
      locationId: IDS.home,
      payload: { moveId: MOVE, containerId: T.box3, state: 'unpacked', placeId: P.kitchen },
      seq: 1,
      state: 'pending',
    });
    expect(rows.get(T.box3)?.placeId).toBe(P.kitchen);
  });

  it('lays the latest queued change over each box, and recounts', () => {
    const move = {
      id: MOVE,
      boxes: [
        { containerId: 'a', state: 'packed' },
        { containerId: 'b', state: 'packed' },
      ],
      counts: { packed: 2, in_transit: 0, unpacked: 0, total: 2 },
    } as unknown as Parameters<typeof overlay>[0];
    const op = (containerId: string, state: string, takenAt: string) =>
      ({ payload: { moveId: MOVE, containerId, state }, takenAt }) as unknown as Parameters<
        typeof overlay
      >[1][number];
    const out = overlay(move, [
      op('a', 'in_transit', '2026-10-10T10:00:00Z'),
      op('a', 'unpacked', '2026-10-10T11:00:00Z'),
    ]);
    expect(out.boxes.map((b) => b.state)).toEqual(['unpacked', 'packed']);
    expect(out.counts).toEqual({ packed: 1, in_transit: 0, unpacked: 1, total: 2 });
  });
});
