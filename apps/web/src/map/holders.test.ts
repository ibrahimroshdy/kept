import { mToCm, rectsOverlap, turnOffset, unturnOffset } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import type { MapView } from '@/api/map/types';
import {
  addableOn,
  bodyOf,
  centreOf,
  clampsAtBack,
  dropOn,
  fp,
  freeAlong,
  groundOf,
  holdersFor,
  hostAt,
  type Item,
  moveBy,
  type Plan,
  planOf,
  putOn,
  type Room,
  spotOn,
  standingOn,
  takeOff,
  turn,
} from './layout';

// #137: holders, Put on…, Add on it, Take off, and the drag's finer grid.

const id = (n: number) => `01926f00-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ROOM = id(10);
const OTHER = id(11);

const room: Room = {
  id: ROOM,
  levelKey: '_',
  name: 'Study',
  shortCode: null,
  kindKey: 'room',
  x: 0,
  z: 0,
  w: 5,
  d: 4,
  kind: 'room',
  surface: 'wood',
};
const rooms = [room, { ...room, id: OTHER, name: 'Hall', x: 6 }];

let n = 100;
const item = (over: Partial<Item>): Item => ({
  id: id(n++),
  subject: 'thing',
  roomId: ROOM,
  name: 'x',
  shortCode: null,
  model: 'item',
  x: 1,
  z: 1,
  rot: 0,
  on: null,
  parentId: ROOM,
  isContainer: false,
  quantity: 1,
  auto: false,
  ...over,
});

const near = (a: { x: number; z: number }, b: { x: number; z: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.z).toBeCloseTo(b.z, 6);
};
const rect = (it: Item) => ({ x: it.x, z: it.z, ...fp(it) });

describe('Put on… (#137)', () => {
  it('clips a webcam onto a monitor’s top edge, facing the monitor’s way', () => {
    const monitor = item({ model: 'monitor', name: 'Monitor', x: 2, z: 1, rot: 90 });
    const webcam = item({ model: 'webcam', name: 'HD webcam', x: 0.5, z: 3 });
    const items = [monitor, webcam];
    expect(holdersFor(items, webcam).map((h) => h.id)).toEqual([monitor.id]);
    expect(putOn(items, webcam, monitor)).toBe(true);
    expect(webcam.on).toBe(monitor.id);
    expect(webcam.rot).toBe(90);
    // Centred on the edge's line: 3 cm in front of the monitor's middle, turned with it.
    near(centreOf(webcam), spotOn(monitor, 0));
    const mc = centreOf(monitor);
    near(centreOf(webcam), { x: mc.x - 0.03, z: mc.z });
  });

  it('lists only what in the room can carry it, with room for it', () => {
    const desk = item({ model: 'desk', name: 'Corner desk' });
    const sofa = item({ model: 'sofa', name: 'Sofa', x: 3 });
    const hallDesk = item({ model: 'desk', name: 'Hall desk', roomId: OTHER });
    const arm = item({ model: 'monitor_arm', name: 'Arm', on: desk.id });
    const speaker = item({ model: 'speaker', name: 'Speaker', x: 4 });
    const monitor = item({ model: 'monitor', name: 'Monitor', x: 3, z: 3 });
    const items = [desk, sofa, hallDesk, arm, speaker, monitor];
    expect(holdersFor(items, speaker).map((h) => h.name)).toEqual(['Corner desk']);
    // A monitor lists the arm (and the desk); once the arm holds one, only the desk.
    expect(holdersFor(items, monitor).map((h) => h.name)).toEqual(['Arm', 'Corner desk']);
    const other = item({ model: 'monitor', name: 'Other', x: 0.5, z: 3 });
    items.push(other);
    expect(putOn(items, other, arm)).toBe(true);
    expect(holdersFor(items, monitor).map((h) => h.name)).toEqual(['Corner desk']);
  });

  it('takes it off onto the floor beside what its holder stands on', () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1 });
    const monitor = item({ model: 'monitor', name: 'Monitor' });
    const webcam = item({ model: 'webcam', name: 'HD webcam' });
    const items = [desk, monitor, webcam];
    putOn(items, monitor, desk);
    putOn(items, webcam, monitor);
    expect(groundOf(items, webcam).id).toBe(desk.id);
    takeOff(items, rooms, webcam);
    expect(webcam.on).toBeNull();
    expect(rectsOverlap(rect(webcam), rect(desk))).toBe(false);
    // To the desk's side, level with its middle.
    expect(webcam.x).toBeCloseTo(desk.x + fp(desk).w + 0.05);
    expect(centreOf(webcam).z).toBeCloseTo(centreOf(desk).z);
  });

  it('never makes a loop', () => {
    const box = item({ model: 'box', name: 'Box' });
    const crate = item({ model: 'crate', name: 'Crate' });
    const items = [box, crate];
    expect(putOn(items, crate, box)).toBe(true);
    expect(putOn(items, box, crate)).toBe(false);
    expect(holdersFor(items, box).map((h) => h.id)).not.toContain(crate.id);
  });
});

describe('Add on it (#137)', () => {
  it('puts three things on a desk side by side, not overlapping', () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1 });
    const things = [
      item({ model: 'laptop', name: 'Laptop', x: 0.2, z: 3 }),
      item({ model: 'keyboard', name: 'Keyboard', x: 1, z: 3 }),
      item({ model: 'smart_speaker', name: 'Echo', x: 2, z: 3 }),
    ];
    const items = [desk, ...things];
    expect(addableOn(items, desk).map((c) => c.name)).toEqual(['Echo', 'Keyboard', 'Laptop']);
    for (const t of things) expect(putOn(items, t, desk)).toBe(true);
    for (const t of things) expect(t.on).toBe(desk.id);
    for (let i = 0; i < things.length; i++)
      for (let j = i + 1; j < things.length; j++)
        expect(rectsOverlap(rect(things[i] as Item), rect(things[j] as Item))).toBe(false);
    // All on the desk's top.
    for (const t of things) {
      const c = centreOf(t);
      expect(c.x).toBeGreaterThan(desk.x);
      expect(c.x).toBeLessThan(desk.x + fp(desk).w);
    }
    expect(addableOn(items, desk)).toEqual([]);
  });

  it('puts a keyboard in front of a monitor in the desk’s middle, not on its stand', () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1 });
    const monitor = item({ model: 'monitor', name: 'Monitor' });
    const keyboard = item({ model: 'keyboard', name: 'Keyboard' });
    const items = [desk, monitor, keyboard];
    putOn(items, monitor, desk);
    near(centreOf(monitor), centreOf(desk));
    putOn(items, keyboard, desk);
    expect(rectsOverlap(rect(keyboard), rect(monitor))).toBe(false);
    // In front of it (+z, the desk's front), still on the desk.
    expect(centreOf(keyboard).z).toBeGreaterThan(centreOf(monitor).z);
    expect(keyboard.z + fp(keyboard).d).toBeLessThanOrEqual(desk.z + fp(desk).d + 1e-9);
  });

  it('fills a dual arm’s two places, then says it is full', () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1 });
    const arm = item({ model: 'dual_monitor_arm', name: 'Arm' });
    const left = item({ model: 'monitor', name: 'Left', x: 0.2, z: 3 });
    const right = item({ model: 'monitor', name: 'Right', x: 1.2, z: 3 });
    const third = item({ model: 'monitor', name: 'Third', x: 2.2, z: 3 });
    const items = [desk, arm, left, right, third];
    putOn(items, arm, desk);
    expect(addableOn(items, arm).map((c) => c.name)).toEqual(['Left', 'Right', 'Third']);
    expect(putOn(items, left, arm)).toBe(true);
    expect(putOn(items, right, arm)).toBe(true);
    expect(putOn(items, third, arm)).toBe(false);
    expect(addableOn(items, arm)).toEqual([]);
    expect(freeAlong(items, arm, third)).toBeNull();
    // Side by side, 64 cm apart, 22 cm in front of the pole.
    const ac = centreOf(arm);
    near(centreOf(left), { x: ac.x - 0.32, z: ac.z + 0.22 });
    near(centreOf(right), { x: ac.x + 0.32, z: ac.z + 0.22 });
    expect(rectsOverlap(rect(left), rect(right))).toBe(false);
  });
});

describe('stacks on holders (#137)', () => {
  const office = () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1 });
    const arm = item({ model: 'dual_monitor_arm', name: 'Arm' });
    const left = item({ model: 'monitor', name: 'Left' });
    const right = item({ model: 'monitor', name: 'Right' });
    const webcam = item({ model: 'webcam', name: 'HD webcam' });
    const items = [desk, arm, left, right, webcam];
    putOn(items, arm, desk);
    putOn(items, left, arm);
    putOn(items, right, arm);
    putOn(items, webcam, left);
    return { items, desk, arm, left, right, webcam };
  };

  it('keeps a webcam on a monitor that is on an arm', () => {
    const { items, desk, arm, left, webcam } = office();
    expect(webcam.on).toBe(left.id);
    expect(standingOn(items, desk.id)).toEqual(
      expect.arrayContaining([arm.id, left.id, webcam.id]),
    );
    near(centreOf(webcam), spotOn(left, 0));
  });

  it('moves the arm, its monitors and their webcam with the desk', () => {
    const { items, desk, arm, left, right, webcam } = office();
    const before = [arm, left, right, webcam].map(centreOf);
    moveBy(items, desk, 0.5, 0.25);
    [arm, left, right, webcam].forEach((t, i) => {
      const b = before[i] as { x: number; z: number };
      near(centreOf(t), { x: b.x + 0.5, z: b.z + 0.25 });
    });
  });

  it('turns the whole stack with the desk, and keeps everything seated', () => {
    const { items, desk, arm, left, right, webcam } = office();
    turn(items, rooms, desk);
    for (const t of [arm, left, right, webcam]) expect(t.rot).toBe(90);
    near(centreOf(left), spotOn(arm, -0.32));
    near(centreOf(right), spotOn(arm, 0.32));
    near(centreOf(webcam), spotOn(left, 0));
    // Seated things turn only with their holder.
    turn(items, rooms, left);
    expect(left.rot).toBe(90);
  });

  it('drops a webcam on the monitor, not the desk under it', () => {
    const { items, left, webcam } = office();
    takeOff(items, rooms, webcam);
    const plan: Plan = { levels: [], rooms, items };
    const c = centreOf(left);
    expect(hostAt(plan, '_', c, webcam)?.id).toBe(left.id);
  });
});

describe('the drag’s grid (#137)', () => {
  it('lines a small thing up with the desk by the centimetre, not the room’s 10 cm grid', () => {
    // A desk off the room's grid.
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1.03, z: 1.07 });
    const webcam = item({ model: 'webcam', name: 'HD webcam' });
    const items = [desk, webcam];
    const dc = centreOf(desk);
    dropOn(items, webcam, desk, { x: dc.x + 0.1234, z: dc.z + 0.0512 });
    const c = centreOf(webcam);
    expect(c.x - dc.x).toBeCloseTo(0.12, 6);
    expect(c.z - dc.z).toBeCloseTo(0.05, 6);
    // A 5 cm step for a monitor on the desk.
    const monitor = item({ model: 'monitor', name: 'Monitor' });
    items.push(monitor);
    dropOn(items, monitor, desk, { x: dc.x + 0.123, z: dc.z });
    expect(centreOf(monitor).x - dc.x).toBeCloseTo(0.1, 6);
  });

  it('slides along a screen’s edge and keeps to its line', () => {
    const monitor = item({ model: 'monitor', name: 'Monitor', x: 2, z: 1 });
    const webcam = item({ model: 'webcam', name: 'HD webcam' });
    const items = [monitor, webcam];
    const mc = centreOf(monitor);
    dropOn(items, webcam, monitor, { x: mc.x + 0.137, z: mc.z + 0.09 });
    near(centreOf(webcam), spotOn(monitor, 0.14));
    // Never past the screen's end.
    dropOn(items, webcam, monitor, { x: mc.x + 2, z: mc.z });
    near(centreOf(webcam), spotOn(monitor, 0.31 - 0.05));
  });

  it('takes an arm’s nearest free place', () => {
    const arm = item({ model: 'dual_monitor_arm', name: 'Arm', x: 2, z: 1 });
    const monitor = item({ model: 'monitor', name: 'Monitor' });
    const items = [arm, monitor];
    const ac = centreOf(arm);
    dropOn(items, monitor, arm, { x: ac.x + 0.2, z: ac.z + 0.2 });
    near(centreOf(monitor), spotOn(arm, 0.32));
  });

  it('saves the finer positions to the centimetre', () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1.03, z: 1.07 });
    const webcam = item({ model: 'webcam', name: 'HD webcam' });
    const items = [desk, webcam];
    putOn(items, webcam, desk);
    const body = bodyOf(
      { levels: [{ key: '_', id: null, name: 'x', short: 'x' }], rooms, items },
      null,
    );
    const saved = body.nodes.find((x) => x.id === webcam.id);
    expect(saved).toMatchObject({ hostId: desk.id, x: mToCm(webcam.x), z: mToCm(webcam.z) });
    expect(saved?.x).toBe(Math.round(webcam.x * 100));
  });
});

describe('old saves (#137)', () => {
  const v = (nodes: MapView['nodes']): MapView => ({
    locationId: id(99),
    canArrange: true,
    version: 'v1',
    levels: [{ id: null, name: null }],
    rooms: [
      {
        id: ROOM,
        name: 'Study',
        shortCode: null,
        levelId: null,
        kindKey: 'room',
        layout: { x: 0, z: 0, w: 500, d: 400, kind: 'room', surface: 'wood' },
      },
    ],
    nodes,
    things: [],
    more: 0,
    attention: [],
  });
  const node = (nid: string, model: string, hostId: string | null, x = 100) => ({
    id: nid,
    subject: 'thing' as const,
    name: model,
    shortCode: null,
    roomId: ROOM,
    parentId: ROOM,
    kindKey: null,
    typeKey: null,
    isContainer: false,
    quantity: 1,
    layout: { x, z: 100, rot: 0, model, hostId },
  });

  it('reads a laptop on a desk exactly as before', () => {
    const p = planOf(v([node(id(1), 'desk', null), node(id(2), 'laptop', id(1), 120)]), {
      noFloor: '-',
      location: 'Maple flat',
    });
    expect(p.items.find((i) => i.id === id(2))).toMatchObject({ on: id(1), x: 1.2, z: 1 });
  });

  it('drops what a holder can’t carry, and more than an arm holds', () => {
    const p = planOf(
      v([
        node(id(1), 'monitor', null),
        node(id(2), 'speaker', id(1)),
        node(id(3), 'monitor_arm', null, 300),
        node(id(4), 'monitor', id(3)),
        node(id(5), 'monitor', id(3)),
      ]),
      { noFloor: '-', location: 'Maple flat' },
    );
    const on = (x: string) => p.items.find((i) => i.id === x)?.on;
    expect(on(id(2))).toBeNull();
    expect(on(id(4))).toBe(id(3));
    expect(on(id(5))).toBeNull();
  });
});

describe('arms clamp at the back edge (#151)', () => {
  // A desk's front is +z in its own frame: the back edge is the side away from the chair.
  const BACK = -(fp({ model: 'desk', rot: 0 }).d / 2 - 0.05);
  const local = (desk: Item, t: Item) => {
    const dc = centreOf(desk);
    const c = centreOf(t);
    return unturnOffset(c.x - dc.x, c.z - dc.z, desk.rot);
  };

  it('stands a dual arm at the middle of a Corner desk’s back edge, monitors over the desk', () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1 });
    const arm = item({ model: 'dual_monitor_arm', name: 'Dual arm', x: 3, z: 3 });
    const left = item({ model: 'monitor', name: 'Left' });
    const right = item({ model: 'monitor', name: 'Right' });
    const items = [desk, arm, left, right];
    expect(clampsAtBack(arm.model)).toBe(true);
    expect(clampsAtBack('webcam')).toBe(false);
    expect(putOn(items, arm, desk)).toBe(true);
    near(local(desk, arm), { x: 0, z: BACK });
    putOn(items, left, arm);
    putOn(items, right, arm);
    // In front of the pole, and over the desk.
    for (const m of [left, right]) {
      expect(local(desk, m).z).toBeGreaterThan(local(desk, arm).z);
      expect(Math.abs(local(desk, m).z)).toBeLessThan(fp(desk).d / 2);
    }
  });

  it('takes a back corner when the middle of the back is taken', () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1 });
    const first = item({ model: 'monitor_arm', name: 'Arm' });
    const second = item({ model: 'monitor_arm', name: 'Arm 2' });
    const items = [desk, first, second];
    putOn(items, first, desk);
    putOn(items, second, desk);
    near(local(desk, first), { x: 0, z: BACK });
    near(local(desk, second), { x: -(fp(desk).w / 2 - 0.05), z: BACK });
  });

  it('puts an arm on a turned desk at that desk’s back, facing its way', () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1, rot: 180 });
    const arm = item({ model: 'monitor_arm', name: 'Arm' });
    const items = [desk, arm];
    putOn(items, arm, desk);
    expect(arm.rot).toBe(180);
    near(local(desk, arm), { x: 0, z: BACK });
    // In the room, the back of a desk turned half round is towards +z.
    expect(centreOf(arm).z).toBeGreaterThan(centreOf(desk).z);
  });

  it('keeps the arm at the back when the desk turns', () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1 });
    const arm = item({ model: 'dual_monitor_arm', name: 'Dual arm' });
    const left = item({ model: 'monitor', name: 'Left' });
    const items = [desk, arm, left];
    putOn(items, arm, desk);
    putOn(items, left, arm);
    for (let i = 0; i < 4; i++) {
      turn(items, rooms, desk);
      near(local(desk, arm), { x: 0, z: BACK });
      expect(local(desk, left).z).toBeGreaterThan(local(desk, arm).z);
    }
  });

  it('snaps a dragged arm onto the back edge, sliding along it', () => {
    const desk = item({ model: 'desk', name: 'Corner desk', x: 1, z: 1, rot: 90 });
    const arm = item({ model: 'monitor_arm', name: 'Arm' });
    const items = [desk, arm];
    const dc = centreOf(desk);
    // Dropped near the desk's front, a little to one side.
    const p = turnOffset(0.3, 0.2, desk.rot);
    dropOn(items, arm, desk, { x: dc.x + p.x, z: dc.z + p.z });
    expect(arm.on).toBe(desk.id);
    expect(arm.rot).toBe(90);
    near(local(desk, arm), { x: 0.3, z: BACK });
    // Past the end, it stops at the corner.
    const far = turnOffset(2, 0, desk.rot);
    dropOn(items, arm, desk, { x: dc.x + far.x, z: dc.z + far.z });
    near(local(desk, arm), { x: fp({ model: 'desk', rot: 0 }).w / 2 - 0.05, z: BACK });
  });
});
