import { describe, expect, it } from 'vitest';
import { otherConditionKind, pairRooms } from './condition.js';

const room = (id: string, name: string, placeId: string | null = null) => ({ id, name, placeId });

describe('pairRooms', () => {
  it('pairs by place first, then by name, and keeps the first report’s order', () => {
    const a = [room('a1', 'Kitchen', 'p1'), room('a2', 'Bedroom', 'p2'), room('a3', 'Balcony')];
    const b = [room('b1', 'Main bedroom', 'p2'), room('b2', '  balcony '), room('b3', 'Kitchen')];
    expect(pairRooms(a, b).map((p) => [p.a?.id ?? null, p.b?.id ?? null])).toEqual([
      // p1 has no partner by place, so the kitchen is paired by its name.
      ['a1', 'b3'],
      // The same place, renamed between the two reports.
      ['a2', 'b1'],
      ['a3', 'b2'],
    ]);
  });

  it('lists the rooms either side lacks, and uses each room once', () => {
    const a = [room('a1', 'Hall'), room('a2', 'Hall'), room('a3', 'Study', 'p9')];
    const b = [room('b1', 'hall'), room('b2', 'Garden')];
    expect(pairRooms(a, b).map((p) => [p.a?.id ?? null, p.b?.id ?? null])).toEqual([
      ['a1', 'b1'],
      ['a2', null],
      ['a3', null],
      [null, 'b2'],
    ]);
  });

  it('names the other kind', () => {
    expect(otherConditionKind('move_in')).toBe('move_out');
    expect(otherConditionKind('move_out')).toBe('move_in');
  });
});
