import { describe, expect, it } from 'vitest';
import type { MapAttention, MapView } from '@/api/map/types';
import { contentsOf, planOf } from './layout';
import { attentionGroups, matches, roomCards, summaryOf, whereOf } from './list';

const id = (n: number) => `01926f00-0000-7000-8000-${String(n).padStart(12, '0')}`;
const G = id(1);
const F1 = id(2);
const LIVING = id(10);
const BED = id(11);
const SHELF = id(20);
const BOX = id(21);
const BATT = id(30);
const DRILL = id(31);
const BOOK = id(32);

const att = (
  subjectId: string,
  kind: MapAttention['kind'],
  extra: Partial<MapAttention> = {},
): MapAttention => ({
  subjectId,
  kind,
  title: null,
  sourceType: null,
  state: null,
  dueOn: null,
  person: null,
  quantity: null,
  min: null,
  ...extra,
});

const VIEW: MapView = {
  locationId: id(99),
  canArrange: false,
  version: null,
  levels: [
    { id: G, name: 'Ground floor' },
    { id: F1, name: 'First floor' },
  ],
  rooms: [
    { id: LIVING, name: 'Living room', shortCode: null, levelId: G, kindKey: 'room', layout: null },
    { id: BED, name: 'Bedroom', shortCode: null, levelId: F1, kindKey: 'room', layout: null },
  ],
  nodes: [
    {
      id: SHELF,
      subject: 'place',
      name: 'Shelf A',
      shortCode: 'SHF4A2',
      roomId: LIVING,
      parentId: LIVING,
      kindKey: 'zone',
      typeKey: null,
      isContainer: false,
      quantity: 1,
      layout: null,
    },
    {
      id: BOX,
      subject: 'thing',
      name: 'Games box',
      shortCode: 'GMB0X1',
      roomId: BED,
      parentId: BED,
      kindKey: null,
      typeKey: 'box_bin',
      isContainer: true,
      quantity: 1,
      layout: null,
    },
  ],
  things: [
    { id: BATT, name: 'AA batteries', shortCode: 'K7D2QX', quantity: 4, parentId: SHELF },
    { id: DRILL, name: 'Bosch drill', shortCode: 'DR1LL0', quantity: 1, parentId: LIVING },
    { id: BOX, name: 'Games box', shortCode: 'GMB0X1', quantity: 1, parentId: BED },
    { id: BOOK, name: 'Catan', shortCode: null, quantity: 1, parentId: BOX },
  ],
  more: 3,
  attention: [
    att(BATT, 'low', { quantity: 4, min: 6 }),
    att(DRILL, 'lent', { person: 'Bruce' }),
    att(BOOK, 'due', { title: 'Return it' }),
  ],
};
const plan = planOf(VIEW, { noFloor: 'Not on a floor', location: 'Home' });
const contents = contentsOf(VIEW);

describe('matches', () => {
  it('finds a name, or a short ID typed as printed', () => {
    expect(matches('', 'x', null)).toBe(true);
    expect(matches('batt', 'AA batteries', null)).toBe(true);
    expect(matches('k7d-2qx', 'AA batteries', 'K7D2QX')).toBe(true);
    expect(matches('k7d 2', 'AA batteries', 'K7D2QX')).toBe(true);
    expect(matches('zz', 'AA batteries', 'K7D2QX')).toBe(false);
  });
});

describe('roomCards (By room)', () => {
  it('lists each room’s nodes, then its loose things, with what is in them', () => {
    const cards = roomCards(plan, VIEW, contents, { q: '', floor: 'all', show: 'room' });
    expect(cards.map((c) => c.room.name)).toEqual(['Living room', 'Bedroom']);
    const living = cards[0];
    expect(living?.total).toBe(2);
    expect(living?.rows.map((r) => [r.name, r.kind, r.count])).toEqual([
      ['Shelf A', 'node', 1],
      ['Bosch drill', 'thing', null],
    ]);
    expect(living?.rows[0]?.children.map((r) => r.name)).toEqual(['AA batteries']);
    expect(living?.rows[0]?.flags).toEqual(['low']);
    // The box is a node in the bedroom; Catan is in it and due.
    expect(cards[1]?.rows[0]).toMatchObject({ name: 'Games box', count: 1, flags: ['due'] });
  });

  it('filters by floor', () => {
    const cards = roomCards(plan, VIEW, contents, { q: '', floor: F1, show: 'room' });
    expect(cards.map((c) => c.room.id)).toEqual([BED]);
  });

  it('keeps only rooms and rows with a match, and the path down to it', () => {
    const cards = roomCards(plan, VIEW, contents, { q: 'catan', floor: 'all', show: 'room' });
    expect(cards.map((c) => c.room.id)).toEqual([BED]);
    expect(cards[0]?.rows[0]?.children.map((r) => r.name)).toEqual(['Catan']);
    expect(
      roomCards(plan, VIEW, contents, { q: 'K7D', floor: 'all', show: 'room' })[0]?.room.id,
    ).toBe(LIVING);
    expect(
      roomCards(plan, VIEW, contents, { q: 'nothing like it', floor: 'all', show: 'room' }),
    ).toEqual([]);
  });
});

describe('attentionGroups (Needs attention)', () => {
  it('groups low, lent and due, each with where it is', () => {
    const groups = attentionGroups(plan, VIEW, { q: '', floor: 'all', show: 'attention' });
    expect(groups.map((g) => [g.kind, g.rows.map((r) => r.name)])).toEqual([
      ['low', ['AA batteries']],
      ['lent', ['Bosch drill']],
      ['due', ['Catan']],
    ]);
    expect(groups[0]?.rows[0]?.where).toEqual(['Living room', 'Shelf A']);
    expect(groups[2]?.rows[0]?.where).toEqual(['Bedroom', 'Games box']);
  });

  it('filters by floor and by words, the place included', () => {
    const first = attentionGroups(plan, VIEW, { q: '', floor: F1, show: 'attention' });
    expect(first.flatMap((g) => g.rows.map((r) => r.id))).toEqual([BOOK]);
    const shelf = attentionGroups(plan, VIEW, { q: 'shelf', floor: 'all', show: 'attention' });
    expect(shelf.flatMap((g) => g.rows.map((r) => r.id))).toEqual([BATT]);
  });
});

describe('summaryOf and whereOf', () => {
  it('counts everything, past the list’s cap too', () => {
    expect(summaryOf(plan, VIEW)).toEqual({
      things: 7,
      rooms: 2,
      floors: 2,
      low: 1,
      lent: 1,
      due: 1,
    });
  });

  it('walks up to the room', () => {
    expect(whereOf(plan, VIEW, BOOK)).toEqual({ path: ['Bedroom', 'Games box'], roomId: BED });
    expect(whereOf(plan, VIEW, LIVING).roomId).toBe(LIVING);
  });
});
