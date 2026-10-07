import { describe, expect, it } from 'vitest';
import type { ResolvedField, ThingView } from '@/api/inventory/types';
import { merge } from '@/lib/three-way';
import {
  editableFields,
  formValues,
  mergeFields,
  parseNumber,
  toPatch,
  validate,
  westernNumber,
} from './form-model';

const field = (
  key: string,
  kind: ResolvedField['kind'],
  extra: Partial<ResolvedField> = {},
): ResolvedField => ({
  id: key,
  key,
  label: null,
  labelKey: key,
  kind,
  unit: null,
  options: null,
  repeatable: false,
  required: false,
  secret: false,
  sort: 0,
  archivedAt: null,
  source: { typeId: 't', via: 'own' },
  rowVersion: 1,
  ...extra,
});

const fields = [
  field('length', 'number', { unit: 'm' }),
  field('mac_address', 'text', { repeatable: true }),
  field('complete', 'boolean'),
  field('price', 'money'),
  field('linked_account', 'text', { secret: true }),
  field('old', 'text', { archivedAt: '2026-01-01' }),
];

const thing = {
  name: 'Cable',
  quantity: 3,
  brand: null,
  model: null,
  serial: null,
  barcode: null,
  colour: null,
  condition: null,
  notes: null,
  manualUrl: null,
  expiresOn: null,
  fields,
  custom: { length: 2, mac_address: ['a', 'b'], complete: true },
} as unknown as ThingView;

const messages = {
  nameRequired: 'required',
  tooLong: (n: number) => `max ${n}`,
  number: 'number',
  quantity: 'quantity',
  url: 'url',
  amount: 'amount',
};

describe('form model', () => {
  it('offers neither secret nor archived fields', () => {
    expect(editableFields(fields).map((f) => f.key)).toEqual([
      'length',
      'mac_address',
      'complete',
      'price',
    ]);
    expect(mergeFields(fields)).toContain('custom.length');
    expect(mergeFields(fields)).not.toContain('custom.linked_account');
  });

  it('reads Eastern Arabic and Persian digits and the Arabic decimal separator (D172)', () => {
    expect(westernNumber('١٬٢٠٠٫٥')).toBe('1200.5');
    expect(parseNumber('۴۲')).toBe(42);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNaN();
  });

  it('turns only the changed values back into wire types', () => {
    const base = formValues(thing);
    expect(base.quantity).toBe('3');
    expect(base.custom.length).toBe('2');
    const mine = {
      ...base,
      quantity: '٤',
      model: '  X1 ',
      custom: {
        ...base.custom,
        length: '٢٫٥',
        complete: false,
        price: { amount: '١٢٠٠', currency: 'EGP' },
      },
    };
    expect(toPatch(base, mine, fields)).toEqual({
      quantity: 4,
      model: 'X1',
      custom: { length: 2.5, complete: false, price: { amount: '1200', currency: 'EGP' } },
    });
  });

  it('clearing a value sends null, which removes it', () => {
    const base = formValues(thing);
    expect(toPatch(base, { ...base, custom: { ...base.custom, mac_address: [] } }, fields)).toEqual(
      {
        custom: { mac_address: null },
      },
    );
  });

  it('validates the changed fields only', () => {
    const base = formValues(thing);
    expect(validate(base, { ...base, name: ' ' }, fields, messages)).toEqual({ name: 'required' });
    expect(validate(base, { ...base, quantity: '1.5' }, fields, messages)).toEqual({
      quantity: 'quantity',
    });
    expect(
      validate(base, { ...base, custom: { ...base.custom, length: 'long' } }, fields, messages),
    ).toEqual({ 'custom.length': 'number' });
  });

  it('merges per custom key, so different fields never conflict (D156)', () => {
    const base = formValues(thing);
    const mine = { ...base, custom: { ...base.custom, length: '3' } };
    const theirs = { ...base, custom: { ...base.custom, complete: false } };
    const { merged, conflicts } = merge(base, mine, theirs, mergeFields(fields));
    expect(conflicts).toEqual([]);
    expect(merged.custom).toMatchObject({ length: '3', complete: false });
    expect(toPatch(theirs, merged, fields)).toEqual({ custom: { length: 3 } });
  });
});
