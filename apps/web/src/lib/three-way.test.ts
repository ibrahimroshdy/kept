import { describe, expect, it } from 'vitest';
import { merge } from './three-way';

type Row = Record<string, unknown>;
const FIELDS = ['name', 'model', 'serial', 'custom.voltage', 'tagIds'];

describe('three-way merge (D156)', () => {
  const base: Row = {
    name: 'Drill',
    model: 'GSR 18',
    serial: null,
    custom: { voltage: 18 },
    tagIds: ['a'],
  };

  it.each([
    {
      case: 'only they changed a field: take theirs',
      mine: base,
      theirs: { ...base, model: 'GSR 18V-55' },
      merged: { model: 'GSR 18V-55' },
      conflicts: [],
    },
    {
      case: 'only I changed a field: keep mine',
      mine: { ...base, name: 'Bosch drill' },
      theirs: base,
      merged: { name: 'Bosch drill' },
      conflicts: [],
    },
    {
      case: 'we both changed different fields: both land',
      mine: { ...base, name: 'Bosch drill' },
      theirs: { ...base, model: 'GSR 18V-55' },
      merged: { name: 'Bosch drill', model: 'GSR 18V-55' },
      conflicts: [],
    },
    {
      case: 'we both changed a field to the same value: no conflict',
      mine: { ...base, serial: 'X1' },
      theirs: { ...base, serial: 'X1' },
      merged: { serial: 'X1' },
      conflicts: [],
    },
    {
      case: 'we both changed a field to different values: a conflict, mine kept for now',
      mine: { ...base, name: 'Bosch drill' },
      theirs: { ...base, name: 'Drill (garage)' },
      merged: { name: 'Bosch drill' },
      conflicts: [{ field: 'name', mine: 'Bosch drill', theirs: 'Drill (garage)' }],
    },
    {
      case: 'nested custom keys are compared one by one',
      mine: { ...base, custom: { voltage: 20 } },
      theirs: { ...base, custom: { voltage: 12 } },
      merged: { custom: { voltage: 20 } },
      conflicts: [{ field: 'custom.voltage', mine: 20, theirs: 12 }],
    },
    {
      case: 'arrays compare by value, not identity',
      mine: { ...base, tagIds: ['a'] },
      theirs: { ...base, tagIds: ['a', 'b'] },
      merged: { tagIds: ['a', 'b'] },
      conflicts: [],
    },
    {
      case: 'a cleared value (null) is a change like any other',
      mine: { ...base, model: null },
      theirs: { ...base, model: 'GSR 18V-55' },
      merged: { model: null },
      conflicts: [{ field: 'model', mine: null, theirs: 'GSR 18V-55' }],
    },
  ])('$case', ({ mine, theirs, merged, conflicts }) => {
    const out = merge(base, mine, theirs, FIELDS);
    expect(out.merged).toMatchObject(merged);
    expect(out.conflicts).toEqual(conflicts);
  });

  it('only the listed fields are merged; others come from theirs', () => {
    const out = merge({ a: 1, rowVersion: 1 }, { a: 1, rowVersion: 1 }, { a: 1, rowVersion: 2 }, [
      'a',
    ]);
    expect(out.merged).toEqual({ a: 1, rowVersion: 2 });
  });

  it('does not mutate its inputs', () => {
    const mine = { ...base, custom: { voltage: 20 } };
    const theirs = { ...base, custom: { voltage: 12 } };
    merge(base, mine, theirs, FIELDS);
    expect(theirs.custom).toEqual({ voltage: 12 });
    expect(mine.custom).toEqual({ voltage: 20 });
  });
});
