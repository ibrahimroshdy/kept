import { describe, expect, it } from 'vitest';
import { HB_FIELD_KIND, HB_ISSUE_CODES, HomeboxChoices, homeboxAssetCode } from './homebox.js';
import { parseScan } from './scan.js';

const TYPE = '0192f0a0-0000-7000-8000-000000000001';

const choices = {
  archived: 'skip',
  currency: 'EGP',
  quantityRounding: 'keep_note',
  fields: { Voltage: 'add_to_type', 'Door code': 'notes' },
  types: { [TYPE]: { create: 'Power tool' } },
  insured: 'field',
  seeded: 'skip_unused',
} as const;

describe('HomeboxChoices (D146)', () => {
  it('accepts a full set of choices', () => {
    expect(HomeboxChoices.parse(choices)).toEqual(choices);
    expect(
      HomeboxChoices.parse({ ...choices, types: { [TYPE]: { typeId: TYPE } } }).types[TYPE],
    ).toEqual({ typeId: TYPE });
  });

  it('refuses an unknown key, a lower-case currency and a type given both ways', () => {
    expect(HomeboxChoices.safeParse({ ...choices, extra: 1 }).success).toBe(false);
    expect(HomeboxChoices.safeParse({ ...choices, currency: 'usd' }).success).toBe(false);
    expect(
      HomeboxChoices.safeParse({ ...choices, types: { [TYPE]: { typeId: TYPE, create: 'x' } } })
        .success,
    ).toBe(false);
    expect(HomeboxChoices.safeParse({ ...choices, seeded: undefined }).success).toBe(false);
  });
});

describe('homeboxAssetCode', () => {
  it.each([
    [1, '000-001'],
    [42, '000-042'],
    [123456, '123-456'],
  ])('writes %i as %s, the form a scanned label resolves to', (n, code) => {
    expect(homeboxAssetCode(n)).toBe(code);
    expect(parseScan(`https://homebox.example/a/${n}`)).toMatchObject({ assetId: code });
  });

  it('has no code for 0 (none), a fraction or more than six digits', () => {
    expect(homeboxAssetCode(0)).toBeNull();
    expect(homeboxAssetCode(1.5)).toBeNull();
    expect(homeboxAssetCode(1_000_000)).toBeNull();
  });
});

describe('Homebox field kinds and issues', () => {
  it('maps time to date and keeps the rest', () => {
    expect(HB_FIELD_KIND).toEqual({
      text: 'text',
      number: 'number',
      boolean: 'boolean',
      time: 'date',
    });
  });

  it('prefixes every issue code with hb_', () => {
    expect(HB_ISSUE_CODES.every((c) => c.startsWith('hb_'))).toBe(true);
    expect(new Set(HB_ISSUE_CODES).size).toBe(HB_ISSUE_CODES.length);
  });
});
