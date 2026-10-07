import { describe, expect, it } from 'vitest';
import { checkLinks, locationsIn, seenIn } from './cite.js';

const HOME = '01a10ede-0000-7000-8000-000000000001';
const GARAGE = '01a10ede-0000-7000-8000-000000000002';
const THING = '01a10ede-0000-7000-8000-0000000000aa';
const PLACE = '01a10ede-0000-7000-8000-0000000000bb';

const output = {
  data: {
    items: [
      { id: THING, short_code: 'K7D2QX', location_id: HOME, untrusted: { name: 'Drill' } },
      { id: PLACE, location_id: GARAGE, kind: 'shelf', untrusted: { name: 'Shelf 2' } },
    ],
  },
};

describe('cite', () => {
  it('a result names the reachable locations it holds, and nothing else', () => {
    expect(locationsIn(output, new Set([HOME, GARAGE])).sort()).toEqual([HOME, GARAGE].sort());
    expect(locationsIn(output, new Set([HOME]))).toEqual([HOME]);
    expect(locationsIn({ untrusted: { name: HOME } }, new Set([GARAGE]))).toEqual([]);
  });

  it('seen things and places map to their location', () => {
    expect(seenIn([output])).toEqual(
      new Map([
        [THING, HOME],
        [PLACE, GARAGE],
      ]),
    );
  });

  it('links to what a tool showed stay; any other kept: link is reduced to its words', () => {
    const ghost = '01a10ede-0000-7000-8000-0000000000cc';
    const r = checkLinks(
      `[Drill](kept:thing/${THING}) on [Shelf 2](kept:place/${PLACE}), not [Saw](kept:thing/${ghost}) or [x](kept:thing/K7D2QX).`,
      seenIn([output]),
    );
    expect(r.text).toBe(
      `[Drill](kept:thing/${THING}) on [Shelf 2](kept:place/${PLACE}), not Saw or x.`,
    );
    expect(r.cited.sort()).toEqual([HOME, GARAGE].sort());
    expect(r.stripped).toBe(2);
  });
});
