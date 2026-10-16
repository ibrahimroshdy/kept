import { describe, expect, it } from 'vitest';
import { fieldShown, isNewValue } from './fields';

describe('fieldShown (#140)', () => {
  it.each([
    ['name', 'thing', true],
    ['notes', 'thing', true],
    ['quantity', 'thing', true],
    ['custom.insured_value', 'thing', true],
    ['custom.serial_id', 'thing', true],
    ['place_id', 'thing', false],
    ['file_ids', 'thing', false],
    ['thingIds', 'thing', false],
    ['id', 'thing', false],
    ['version', 'thing', false],
    ['moved', 'place', false],
    ['trashed', 'place', false],
    ['digits', 'location', false],
    ['locale', 'location', false],
    ['include', 'report', false],
    ['filters', 'report', false],
    ['kind', 'report', false],
    ['layout', 'location', false],
    ['name', 'location', true],
    ['mime', 'file', false],
  ])('%s on a %s: %s', (key, entity, shown) => {
    expect(fieldShown(key, entity)).toBe(shown);
  });

  it('treats a field set from nothing as new', () => {
    for (const v of [null, undefined, '', [], {}]) expect(isNewValue(v)).toBe(true);
    for (const v of ['Desk', 0, false, ['a']]) expect(isNewValue(v)).toBe(false);
  });
});
