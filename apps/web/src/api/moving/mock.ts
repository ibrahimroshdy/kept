/**
 * Mock handlers for moving mode (1.x, D251), after apps/server/src/moving: a move in a location
 * the caller sees, numbered boxes made for it (a box thing in the location, "<prefix> <n>") or
 * chosen, a state per box, and unpacking, which moves the box (and so what is inside it) into its
 * room. Viewers read; members and above write; a done move takes no box changes (409
 * `move_done`). A state change and an unpack record an undoable event, so the Undo toast works.
 * The contents sheets are a run on the inventory report's mock (`GET /reports/:id`).
 */
import {
  type BoxState,
  boxName,
  countBoxes,
  MAX_MOVE_BOXES,
  type MoveStatus,
  newId,
} from '@kept/shared';
import { accessOf, liveThing, now, recordEvent, type StoredThing } from '../inventory/mock/db';
import { contentsTemplate } from '../inventory/mock/places';
import { queueReportRun } from '../inventory/mock/reports';
import type { MockState } from '../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, reply, route } from '../mock/kit';
import { movingPaths as p } from './paths';
import type {
  AddBoxBody,
  ContentsSheetsBody,
  CreateMoveBody,
  Move,
  MoveBox,
  MoveRow,
  UnpackBody,
  UpdateBoxBody,
  UpdateMoveBody,
} from './types';

export type StoredBox = {
  containerId: string;
  number: number;
  state: BoxState;
  stateAt: string;
  stateBy: { displayName: string } | null;
  destinationPlaceId: string | null;
  rowVersion: number;
};
export type StoredMove = Omit<MoveRow, 'counts' | 'toLocationName'> & { boxes: StoredBox[] };

const stores = new WeakMap<MockState, StoredMove[]>();
const storeOf = (state: MockState) => {
  let s = stores.get(state);
  if (!s) {
    s = [];
    stores.set(state, s);
  }
  return s;
};

/** For tests: a move as it would be stored. */
export function seedMove(state: MockState, move: StoredMove): void {
  storeOf(state).push(move);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const codeOf = (seed: number) => {
  let out = '';
  let n = seed * 6151 + 40_009;
  for (let i = 0; i < 6; i++) {
    out += CROCKFORD[n % 32];
    n = Math.floor(n / 32) + i * 17;
  }
  return out;
};

const done = () =>
  err(
    409,
    'conflict',
    'This conflicts with a change already made.',
    'This move is marked done. Open it again to change its boxes.',
    { reason: 'move_done' },
  );

export function movingMockRoutes(state: MockState): MockRoute[] {
  const moves = () => storeOf(state);
  const inv = () => state.inventory;
  const access = () => accessOf(state);
  const me = () => ({ id: state.me.user.id, displayName: state.me.user.displayName });
  const on = (locationId: string) => {
    const l = state.locations.find((x) => x.id === locationId);
    return !!l && (l.effectiveModules ?? l.modules).includes('moving');
  };
  const pathOf = (t: StoredThing): string | null => {
    const place = inv().places.find((x) => x.id === t.placeId);
    if (t.containerId) return inv().things.find((x) => x.id === t.containerId)?.name ?? null;
    return place && !place.isUnplaced ? place.name : null;
  };
  const boxView = (m: StoredMove, b: StoredBox): MoveBox => {
    const t = liveThing(inv(), b.containerId);
    const visible = !!t && access().visible(t.locationId);
    const room = inv().places.find((x) => x.id === b.destinationPlaceId && !x.deletedAt);
    return {
      moveId: m.id,
      containerId: b.containerId,
      number: b.number,
      state: b.state,
      stateAt: b.stateAt,
      stateBy: b.stateBy,
      visible,
      name: visible && t ? t.name : null,
      shortCode: visible && t ? t.shortCode : null,
      locationId: visible && t ? t.locationId : null,
      placeId: visible && t ? t.placeId : null,
      where: visible && t ? pathOf(t) : null,
      contents: visible
        ? inv().things.filter((x) => x.containerId === b.containerId && !x.deletedAt).length
        : 0,
      destination: room ? { placeId: room.id, name: room.name, locationId: room.locationId } : null,
      rowVersion: b.rowVersion,
    };
  };
  const rowOf = (m: StoredMove): MoveRow => {
    const { boxes, ...row } = m;
    const to = state.locations.find((l) => l.id === m.toLocationId);
    return { ...row, toLocationName: to?.name ?? null, counts: countBoxes(boxes) };
  };
  const viewOf = (m: StoredMove): Move => ({
    ...rowOf(m),
    boxes: [...m.boxes].sort((a, b) => a.number - b.number).map((b) => boxView(m, b)),
  });
  const find = (id: string) => {
    const m = moves().find((x) => x.id === id);
    return m && access().visible(m.locationId) ? m : null;
  };
  /** A move to change: null answers, else the reply to send. */
  const writable = (id: string) => {
    const m = find(id);
    if (!m) return { reply: notFound() };
    if (!on(m.locationId)) return { reply: err(409, 'module_off', 'Moving mode is off here.') };
    if (!access().canWrite(m.locationId)) return { reply: forbidden() };
    return { move: m };
  };
  const roomOk = (m: StoredMove, placeId: string) => {
    const pl = inv().places.find((x) => x.id === placeId && !x.deletedAt);
    return !!pl && pl.locationId === (m.toLocationId ?? m.locationId);
  };
  const setState = (m: StoredMove, b: StoredBox, state: BoxState) => {
    const was = { state: b.state, stateAt: b.stateAt, stateBy: b.stateBy };
    b.state = state;
    b.stateAt = now();
    b.stateBy = { displayName: me().displayName };
    b.rowVersion += 1;
    const t = liveThing(inv(), b.containerId);
    recordEvent(inv(), me(), {
      action: 'move_box.update',
      entity: { type: 'thing', id: b.containerId },
      locationId: m.locationId,
      name: t?.name ?? '',
      undo: () => Object.assign(b, was),
    });
  };

  return [
    route('GET', p.moves, ({ query }) => {
      const loc = query.get('locationId');
      const status = query.get('status');
      const items = moves()
        .filter((m) => access().visible(m.locationId) && on(m.locationId))
        .filter((m) => !loc || m.locationId === loc)
        .filter((m) => !status || m.status === status)
        .sort(
          (a, b) =>
            Number(b.status === 'active') - Number(a.status === 'active') ||
            b.createdAt.localeCompare(a.createdAt),
        )
        .map(rowOf);
      return { items, next_cursor: null };
    }),

    route('GET', p.move(':id'), ({ params }) => {
      const m = find(params.id ?? '');
      if (!m) return notFound();
      if (!on(m.locationId)) return err(404, 'module_off', 'Moving mode is off here.');
      return viewOf(m);
    }),

    route('GET', p.boxOf(':id'), ({ params }) => {
      const id = params.id ?? '';
      const m = moves()
        .filter((x) => access().visible(x.locationId) && x.boxes.some((b) => b.containerId === id))
        .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))[0];
      const b = m?.boxes.find((x) => x.containerId === id);
      if (!m || !b) return notFound();
      return { ...boxView(m, b), move: { id: m.id, name: m.name, status: m.status } };
    }),

    route('POST', p.locationMoves(':id'), ({ params, body }) => {
      const locationId = params.id ?? '';
      if (!access().visible(locationId)) return notFound();
      if (!on(locationId)) return err(409, 'module_off', 'Moving mode is off here.');
      if (!access().canWrite(locationId)) return forbidden();
      const b = body as CreateMoveBody;
      if (b.toLocationId && !access().canWrite(b.toLocationId)) return notFound();
      const move: StoredMove = {
        id: b.id ?? newId(),
        locationId,
        toLocationId: b.toLocationId && b.toLocationId !== locationId ? b.toLocationId : null,
        name: b.name.trim(),
        status: 'active',
        createdBy: { displayName: me().displayName },
        createdAt: now(),
        finishedAt: null,
        rowVersion: 1,
        boxes: [],
      };
      moves().push(move);
      return reply(201, viewOf(move));
    }),

    route('PATCH', p.move(':id'), ({ params, body, headers }) => {
      const w = writable(params.id ?? '');
      if (!w.move) return w.reply;
      const m = w.move;
      if (Number((headers['if-match'] ?? '').replace(/"/g, '')) !== m.rowVersion)
        return err(412, 'precondition_failed', 'This changed since you loaded it.', undefined, {
          row_version: m.rowVersion,
        });
      const b = body as UpdateMoveBody;
      if (b.name) m.name = b.name.trim();
      if (b.toLocationId !== undefined) m.toLocationId = b.toLocationId;
      if (b.status) {
        m.status = b.status as MoveStatus;
        m.finishedAt = b.status === 'done' ? (m.finishedAt ?? now()) : null;
      }
      m.rowVersion += 1;
      return viewOf(m);
    }),

    route('DELETE', p.move(':id'), ({ params }) => {
      const w = writable(params.id ?? '');
      if (!w.move) return w.reply;
      const id = w.move.id;
      stores.set(
        state,
        moves().filter((x) => x.id !== id),
      );
      return reply(204);
    }),

    route('POST', p.boxes(':id'), ({ params, body }) => {
      const w = writable(params.id ?? '');
      if (!w.move) return w.reply;
      const m = w.move;
      if (m.status === 'done') return done();
      const b = body as AddBoxBody;
      if (b.destinationPlaceId && !roomOk(m, b.destinationPlaceId))
        return err(400, 'validation', 'Choose a room where the move is going.');
      const number = Math.max(0, ...m.boxes.map((x) => x.number)) + 1;
      if (number > MAX_MOVE_BOXES) return err(409, 'conflict', 'A move holds at most 999 boxes.');
      let containerId: string;
      if ('new' in b) {
        const placeId =
          b.new.placeId ??
          inv().places.find((x) => x.locationId === m.locationId && x.isUnplaced)?.id ??
          null;
        const type = inv().types.find((x) => x.builtinKey === 'box_bin');
        const box: StoredThing = {
          ...contentsTemplate(),
          id: b.new.id ?? newId(),
          locationId: m.locationId,
          name: boxName(b.new.prefix ?? 'Box', number),
          shortCode: codeOf(inv().things.length + number),
          type: type
            ? { id: type.id, icon: type.icon, name: type.name, builtinKey: type.builtinKey }
            : null,
          placeId,
          isContainer: true,
        };
        inv().things.push(box);
        containerId = box.id;
      } else {
        const t = liveThing(inv(), b.containerId);
        if (!t || !access().visible(t.locationId)) return notFound();
        if (t.locationId !== m.locationId)
          return err(400, 'validation', 'Add a box that is in the location being packed.');
        if (
          moves().some((x) => x.status === 'active' && x.boxes.some((y) => y.containerId === t.id))
        )
          return err(409, 'conflict', 'It is already in a move.', undefined, {
            reason: 'already_in_a_move',
          });
        containerId = t.id;
      }
      const stored: StoredBox = {
        containerId,
        number,
        state: 'packed',
        stateAt: now(),
        stateBy: { displayName: me().displayName },
        destinationPlaceId: b.destinationPlaceId ?? null,
        rowVersion: 1,
      };
      m.boxes.push(stored);
      return reply(201, boxView(m, stored));
    }),

    route('PATCH', p.box(':id', ':containerId'), ({ params, body }) => {
      const w = writable(params.id ?? '');
      if (!w.move) return w.reply;
      const m = w.move;
      const box = m.boxes.find((x) => x.containerId === params.containerId);
      if (!box) return notFound();
      if (m.status === 'done') return done();
      const b = body as UpdateBoxBody;
      if (b.destinationPlaceId) {
        if (!roomOk(m, b.destinationPlaceId))
          return err(400, 'validation', 'Choose a room where the move is going.');
        box.destinationPlaceId = b.destinationPlaceId;
      } else if (b.destinationPlaceId === null) box.destinationPlaceId = null;
      if (b.state && b.state !== box.state) setState(m, box, b.state);
      return boxView(m, box);
    }),

    route('POST', p.unpack(':id', ':containerId'), ({ params, body }) => {
      const w = writable(params.id ?? '');
      if (!w.move) return w.reply;
      const m = w.move;
      const box = m.boxes.find((x) => x.containerId === params.containerId);
      if (!box) return notFound();
      if (m.status === 'done') return done();
      const room = (body as UnpackBody | undefined)?.placeId ?? box.destinationPlaceId;
      if (!room)
        return err(400, 'validation', 'Choose the room this box goes to.', undefined, {
          reason: 'no_room',
        });
      if (!roomOk(m, room)) return err(400, 'validation', 'Choose a room where the move is going.');
      const t = liveThing(inv(), box.containerId);
      if (!t) return notFound();
      const place = inv().places.find((x) => x.id === room);
      if (!place || !access().canWrite(place.locationId)) return notFound();
      const was = {
        thing: { placeId: t.placeId, containerId: t.containerId, locationId: t.locationId },
        box: {
          state: box.state,
          stateAt: box.stateAt,
          stateBy: box.stateBy,
          destinationPlaceId: box.destinationPlaceId,
        },
      };
      // The box goes, and what is inside goes with it (it follows its container).
      const carry = (id: string, locationId: string) => {
        for (const c of inv().things)
          if (c.containerId === id && !c.deletedAt) {
            c.locationId = locationId;
            carry(c.id, locationId);
          }
      };
      t.placeId = room;
      t.containerId = null;
      t.locationId = place.locationId;
      carry(t.id, place.locationId);
      box.state = 'unpacked';
      box.stateAt = now();
      box.stateBy = { displayName: me().displayName };
      box.destinationPlaceId = room;
      box.rowVersion += 1;
      recordEvent(inv(), me(), {
        action: 'move_box.unpack',
        entity: { type: 'thing', id: t.id },
        locationId: m.locationId,
        name: t.name ?? '',
        undo: () => {
          Object.assign(t, was.thing);
          carry(t.id, was.thing.locationId);
          Object.assign(box, was.box);
        },
      });
      return boxView(m, box);
    }),

    route('DELETE', p.box(':id', ':containerId'), ({ params }) => {
      const w = writable(params.id ?? '');
      if (!w.move) return w.reply;
      const m = w.move;
      if (!m.boxes.some((x) => x.containerId === params.containerId)) return notFound();
      if (m.status === 'done') return done();
      m.boxes = m.boxes.filter((x) => x.containerId !== params.containerId);
      return reply(204);
    }),

    route('POST', p.sheets, ({ body }) => {
      const b = body as ContentsSheetsBody;
      const m = find(b.moveId);
      if (!m) return notFound();
      return reply(202, queueReportRun(state, { locationId: m.locationId }, m.boxes.length));
    }),
  ];
}
