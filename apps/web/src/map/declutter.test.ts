import { describe, expect, it } from 'vitest';
import { declutter, type LabelBox, LABEL_PRIORITY as P } from './declutter';

const VIEW = { w: 400, h: 300 };
const box = (x: number, y: number, priority: number, w = 80, h = 20): LabelBox => ({
  x,
  y,
  w,
  h,
  priority,
});

describe('declutter (map labels never overlap)', () => {
  it('shows labels that are apart', () => {
    expect(declutter([box(10, 10, P.room), box(200, 10, P.room)], VIEW)).toEqual([true, true]);
  });

  it('hides the lower priority of two that overlap: a room name beats contents', () => {
    // "TV unit · 5" written over "Living room": the room's name stays.
    const shown = declutter([box(40, 40, P.contents), box(60, 45, P.room)], VIEW);
    expect(shown).toEqual([false, true]);
  });

  it('keeps the earlier of two of the same priority', () => {
    expect(declutter([box(10, 10, P.contents), box(20, 15, P.contents)], VIEW)).toEqual([
      true,
      false,
    ]);
  });

  it('keeps a small gap between labels that only touch', () => {
    // 10 + 80 = 90; a box at 91 is 1 px away, inside the 3 px gap.
    expect(declutter([box(10, 10, P.room), box(91, 10, P.room)], VIEW)).toEqual([true, false]);
    expect(declutter([box(10, 10, P.room), box(94, 10, P.room)], VIEW)).toEqual([true, true]);
  });

  it('always shows the selected or hovered thing, over rooms and controls', () => {
    const shown = declutter([box(40, 40, P.room), box(50, 45, P.focus)], VIEW, [
      { x: 0, y: 0, w: 400, h: 60 },
    ]);
    expect(shown).toEqual([false, true]);
  });

  it('hides what would sit under a control on the map, or outside it', () => {
    const controls = [{ x: 300, y: 0, w: 100, h: 300 }];
    expect(declutter([box(310, 100, P.room), box(10, 100, P.room)], VIEW, controls)).toEqual([
      false,
      true,
    ]);
    expect(declutter([box(10, -5, P.room), box(10, 290, P.room)], VIEW)).toEqual([false, false]);
  });

  it('never cuts a label: a label is shown whole or not at all', () => {
    const long = box(10, 10, P.room, 500);
    expect(declutter([long], VIEW)).toEqual([false]);
  });

  it('lets contents appear once zooming in makes room', () => {
    const at = (spread: number) =>
      declutter([box(100, 100, P.room), box(100 + spread, 100 + spread, P.contents)], VIEW);
    expect(at(10)).toEqual([true, false]);
    expect(at(90)).toEqual([true, true]);
  });
});
