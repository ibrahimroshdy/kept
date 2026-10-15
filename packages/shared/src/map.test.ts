import { describe, expect, it } from 'vitest';
import {
  canHost,
  canStandOn,
  firstOverlap,
  footprintOf,
  guessModel,
  isMapModel,
  levelShort,
  MAP_MODEL_KEYS,
  MAP_MODELS,
  MAP_ROOM_KINDS,
  mToCm,
  ROOM_KIND_SURFACE,
  rectsOverlap,
} from './map.js';

describe('the map catalogue (D237)', () => {
  it('gives every model a positive footprint', () => {
    for (const key of MAP_MODEL_KEYS) {
      const m = MAP_MODELS[key];
      expect(m.w, key).toBeGreaterThan(0);
      expect(m.d, key).toBeGreaterThan(0);
    }
  });

  it('gives every room kind a floor', () => {
    for (const k of MAP_ROOM_KINDS) expect(ROOM_KIND_SURFACE[k]).toBeTruthy();
  });

  it('knows its own keys and nothing else', () => {
    expect(isMapModel('sofa')).toBe(true);
    expect(isMapModel('toString')).toBe(false);
    expect(isMapModel('spaceship')).toBe(false);
    expect(isMapModel(3)).toBe(false);
  });

  it('swaps width and depth on a quarter turn only', () => {
    expect(footprintOf('car', 0)).toEqual({ w: 1.78, d: 4.6 });
    expect(footprintOf('car', 90)).toEqual({ w: 4.6, d: 1.78 });
    expect(footprintOf('car', 180)).toEqual({ w: 1.78, d: 4.6 });
    expect(footprintOf('car', 270)).toEqual({ w: 4.6, d: 1.78 });
  });

  it('lets small things stand on counters, desks and boxes', () => {
    expect(canHost('counter')).toBe(true);
    expect(canHost('desk')).toBe(true);
    expect(canHost('sofa')).toBe(false);
    expect(canStandOn('laptop')).toBe(true);
    expect(canStandOn('cardboard')).toBe(true);
    expect(canStandOn('wardrobe')).toBe(false);
  });
});

describe('rectangles', () => {
  it('overlap only when they share area', () => {
    const a = { x: 0, z: 0, w: 4, d: 4 };
    expect(rectsOverlap(a, { x: 4, z: 0, w: 2, d: 2 })).toBe(false);
    expect(rectsOverlap(a, { x: 3.9, z: 3.9, w: 2, d: 2 })).toBe(true);
    expect(firstOverlap([a, { x: 5, z: 0, w: 1, d: 1 }, { x: 5.5, z: 0.5, w: 1, d: 1 }])).toEqual([
      1, 2,
    ]);
    expect(firstOverlap([a, { x: 4, z: 0, w: 1, d: 1 }])).toBeNull();
  });
});

describe('guessModel', () => {
  it('reads the name first', () => {
    expect(guessModel({ name: 'Samsung TV', subject: 'thing' })).toBe('tv');
    expect(guessModel({ name: 'Shelf A', subject: 'place', kindKey: 'zone' })).toBe('metal_shelf');
    expect(guessModel({ name: 'Games box', subject: 'thing', isContainer: true })).toBe('box');
    expect(guessModel({ name: 'Stairs up', subject: 'place' })).toBe('stairs');
  });

  it('then the type or the place kind', () => {
    expect(guessModel({ name: 'Corolla', subject: 'thing', typeKey: 'car' })).toBe('car');
    expect(guessModel({ name: 'Hall cupboard', subject: 'place', kindKey: 'closet' })).toBe(
      'wardrobe',
    );
    expect(guessModel({ name: 'By the door', subject: 'place', kindKey: 'zone' })).toBe('zone');
  });

  it('falls back to storage, a box or a plain block', () => {
    expect(guessModel({ name: 'Under the stairs', subject: 'place', kindKey: 'custom' })).toBe(
      'stairs',
    );
    expect(guessModel({ name: 'Spot', subject: 'place', kindKey: 'custom' })).toBe('metal_shelf');
    expect(guessModel({ name: 'Mystery', subject: 'thing', isContainer: true })).toBe('box');
    expect(guessModel({ name: 'Mystery', subject: 'thing' })).toBe('item');
    expect(guessModel({ name: null, subject: 'thing' })).toBe('item');
  });
});

describe('levelShort', () => {
  it('takes a number, else the first letter, else the position', () => {
    expect(levelShort('Floor 2', 2)).toBe('2');
    expect(levelShort('Ground floor', 0)).toBe('G');
    expect(levelShort('Roof', 3)).toBe('R');
    expect(levelShort('الطابق الأول', 1)).toBe('ا');
    expect(levelShort('', 4)).toBe('4');
  });
});

describe('centimetres', () => {
  it('round to whole centimetres', () => {
    expect(mToCm(1.234)).toBe(123);
    expect(mToCm(0.005)).toBe(1);
  });
});
