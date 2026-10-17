import { turnOffset } from '@kept/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { facingAz, type Item, screensFacing } from './layout';
import { nearestTurn, readTurn, writeTurn } from './turns';

// #150: a room opens facing the front of its screens, or as it was last turned on this device.

const ROOM = 'room-study';
let n = 0;
const item = (over: Partial<Item>): Item => ({
  id: `i${n++}`,
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

describe('screensFacing', () => {
  it('is null in a room without a screen', () => {
    expect(screensFacing([item({ model: 'desk' }), item({ model: 'webcam' })], ROOM)).toBeNull();
  });

  it('takes the turn of the room’s screens, a TV counting more than a laptop', () => {
    const items = [
      item({ model: 'desk', rot: 90 }),
      item({ model: 'monitor', rot: 180 }),
      item({ model: 'laptop', rot: 90 }),
      item({ model: 'tv', rot: 270, roomId: 'elsewhere' }),
    ];
    expect(screensFacing(items, ROOM)).toBe(180);
    expect(screensFacing([...items, item({ model: 'tv', rot: 90 })], ROOM)).toBe(90);
  });

  it('keeps the first turn met on a tie', () => {
    const items = [item({ model: 'monitor', rot: 270 }), item({ model: 'monitor', rot: 0 })];
    expect(screensFacing(items, ROOM)).toBe(270);
  });
});

describe('facingAz', () => {
  it('is the map’s usual view for an unturned screen', () => {
    expect(facingAz(0)).toBeCloseTo(Math.PI / 4);
    // A screen facing +x is seen from the same corner, a whole turn away or not.
    expect(Math.cos(facingAz(270) - Math.PI / 4)).toBeCloseTo(1);
  });

  it('looks from the side with fewer walls in the way', () => {
    // A screen turned half round faces −z: from +x, so only the −z wall is between.
    expect(Math.sin(facingAz(180))).toBeGreaterThan(0);
    expect(Math.cos(facingAz(90))).toBeGreaterThan(0);
  });

  it('puts the camera on the screen’s front side for every turn', () => {
    for (const rot of [0, 90, 180, 270]) {
      const az = facingAz(rot);
      const front = turnOffset(0, 1, rot);
      // The camera sits towards (sin az, cos az): in front of the screen, 45° to its side.
      const dot = Math.sin(az) * front.x + Math.cos(az) * front.z;
      expect(dot).toBeCloseTo(Math.SQRT1_2);
    }
  });
});

describe('remembered turns', () => {
  afterEach(() => localStorage.clear());

  it('remembers a room’s last turn on this device', () => {
    expect(readTurn(ROOM)).toBeNull();
    writeTurn(ROOM, Math.PI / 4 + Math.PI * 2);
    expect(readTurn(ROOM)).toBeCloseTo(Math.PI / 4, 3);
    writeTurn(ROOM, -Math.PI / 4);
    expect(readTurn(ROOM)).toBeCloseTo((7 * Math.PI) / 4, 3);
  });

  it('survives storage that is broken or throws', () => {
    localStorage.setItem('kept.map.turns', '{not json');
    expect(readTurn(ROOM)).toBeNull();
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      expect(() => writeTurn(ROOM, 1)).not.toThrow();
    } finally {
      Storage.prototype.setItem = set;
    }
  });

  it('keeps the newest rooms when there are many', () => {
    for (let i = 0; i < 205; i++) writeTurn(`r${i}`, 1);
    expect(readTurn('r0')).toBeNull();
    expect(readTurn('r204')).toBe(1);
  });

  it('turns the short way round', () => {
    expect(nearestTurn(Math.PI * 4 + 0.1, 0.2)).toBeCloseTo(Math.PI * 4 + 0.2);
    expect(nearestTurn(-0.1, Math.PI * 1.9)).toBeCloseTo(-Math.PI * 0.1);
  });
});
