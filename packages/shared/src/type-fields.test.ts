import { describe, expect, it } from 'vitest';
import { BUILTIN_FIELD_GROUPS, builtinTypeChain, type FieldDef } from './builtin-types.js';
import {
  customSchema,
  FieldRedefinedError,
  fieldValueSchema,
  resolveFields,
} from './type-fields.js';

const UUID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const f = (key: string, kind: FieldDef['kind'], extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  kind,
  names: { en: key, ar: 'حقل' },
  ...extra,
});

describe('resolveFields', () => {
  it('orders inherited fields first, then own fields, then group fields, each with its source', () => {
    const fields = resolveFields(builtinTypeChain('phone'), BUILTIN_FIELD_GROUPS);
    expect(fields.map((x) => `${x.source}.${x.key}`)).toEqual([
      'phone.imei',
      'phone.imei_2',
      'phone.storage',
      'device.os',
      'device.os_version',
      'device.firmware',
      'device.mac_address',
      'device.linked_account',
    ]);
    expect(fields.find((x) => x.key === 'os')?.fromGroup).toBe(true);
    expect(fields.find((x) => x.key === 'imei')?.fromGroup).toBe(false);
  });

  it('walks the whole chain: a car carries the vehicle VIN before its plate', () => {
    const fields = resolveFields(builtinTypeChain('car'), BUILTIN_FIELD_GROUPS);
    expect(fields.map((x) => [x.source, x.key])).toEqual([
      ['vehicle', 'vin'],
      ['car', 'plate'],
    ]);
  });

  it('accepts groups as a plain record, and includes a group referenced twice only once', () => {
    const group = { key: 'g', fields: [f('a', 'text')] };
    const chain = [
      { key: 'p', fields: [], groups: ['g'] },
      { key: 'c', fields: [f('b', 'text')], groups: ['g'] },
    ];
    expect(resolveFields(chain, { g: group }).map((x) => x.key)).toEqual(['a', 'b']);
  });

  it('refuses a key redefined by a child or a group', () => {
    const parent = { key: 'p', fields: [f('serial_no', 'text')] };
    expect(() =>
      resolveFields([parent, { key: 'c', fields: [f('serial_no', 'number')] }], {}),
    ).toThrow(FieldRedefinedError);
    const group = { key: 'g', fields: [f('serial_no', 'text')] };
    expect(() => resolveFields([{ ...parent, groups: ['g'] }], { g: group })).toThrow(/serial_no/);
  });

  it('refuses an unknown group', () => {
    expect(() => resolveFields([{ key: 't', fields: [], groups: ['missing'] }], {})).toThrow(
      /missing/,
    );
  });
});

describe('fieldValueSchema', () => {
  const ok = (field: FieldDef, value: unknown) => fieldValueSchema(field).safeParse(value).success;

  it('text, number, boolean', () => {
    expect(ok(f('t', 'text'), 'hello')).toBe(true);
    expect(ok(f('t', 'text'), 3)).toBe(false);
    expect(ok(f('t', 'text'), 'x'.repeat(2001))).toBe(false);
    expect(ok(f('n', 'number'), 2.5)).toBe(true);
    expect(ok(f('n', 'number'), '2.5')).toBe(false);
    expect(ok(f('n', 'number'), Number.POSITIVE_INFINITY)).toBe(false);
    expect(ok(f('n', 'number'), Number.NaN)).toBe(false);
    expect(ok(f('b', 'boolean'), false)).toBe(true);
    expect(ok(f('b', 'boolean'), 'false')).toBe(false);
  });

  it('date is a calendar date YYYY-MM-DD', () => {
    expect(ok(f('d', 'date'), '2026-09-26')).toBe(true);
    expect(ok(f('d', 'date'), '2026-02-30')).toBe(false);
    expect(ok(f('d', 'date'), '2026-09-26T10:00:00Z')).toBe(false);
  });

  it('select and multi_select check their options', () => {
    const sel = f('s', 'select', { options: ['aa', 'aaa'] });
    expect(ok(sel, 'aa')).toBe(true);
    expect(ok(sel, 'c')).toBe(false);
    const multi = f('m', 'multi_select', { options: ['x', 'y'] });
    expect(ok(multi, ['x', 'y'])).toBe(true);
    expect(ok(multi, ['x', 'z'])).toBe(false);
    expect(ok(multi, ['x', 'x'])).toBe(false);
  });

  it('url is http or https only', () => {
    expect(ok(f('u', 'url'), 'https://example.com/manual.pdf')).toBe(true);
    expect(ok(f('u', 'url'), 'http://192.168.1.1/')).toBe(true);
    expect(ok(f('u', 'url'), 'javascript:alert(1)')).toBe(false);
    expect(ok(f('u', 'url'), 'ftp://example.com')).toBe(false);
  });

  it('money is {amount: decimal string, currency: ISO code}', () => {
    const money = f('v', 'money');
    expect(ok(money, { amount: '1200.5', currency: 'EGP' })).toBe(true);
    expect(ok(money, { amount: '1200.12345', currency: 'EGP' })).toBe(false);
    expect(ok(money, { amount: '-1', currency: 'EGP' })).toBe(false);
    expect(ok(money, { amount: 1200, currency: 'EGP' })).toBe(false);
    expect(ok(money, { amount: '1200', currency: 'egp' })).toBe(false);
    expect(ok(money, { amount: '1200', currency: 'EGP', extra: 1 })).toBe(false);
  });

  it('money amounts come out in canonical form, as the server stores and answers them', () => {
    const money = fieldValueSchema(f('v', 'money'));
    expect(money.parse({ amount: '0150.500', currency: 'EGP' })).toEqual({
      amount: '150.5',
      currency: 'EGP',
    });
    expect(money.parse({ amount: '12.00', currency: 'USD' })).toEqual({
      amount: '12',
      currency: 'USD',
    });
  });

  it('person, vendor and file are uuids', () => {
    for (const kind of ['person', 'vendor', 'file'] as const) {
      expect(ok(f('r', kind), UUID)).toBe(true);
      expect(ok(f('r', kind), 'not-a-uuid')).toBe(false);
    }
  });

  it('repeatable wraps the value in an array', () => {
    const mac = f('mac', 'text', { repeatable: true });
    expect(ok(mac, ['aa:bb', 'cc:dd'])).toBe(true);
    expect(ok(mac, 'aa:bb')).toBe(false);
  });
});

describe('customSchema', () => {
  const fields = resolveFields(builtinTypeChain('computer'), BUILTIN_FIELD_GROUPS);
  const schema = customSchema(fields);

  it('accepts known fields, all optional', () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ cpu: 'M3', mac_address: ['aa:bb'] }).success).toBe(true);
  });

  it('is strict: unknown keys are refused', () => {
    expect(schema.safeParse({ cpu: 'M3', colour: 'red' }).success).toBe(false);
  });

  it('refuses secret fields, pointing at the secrets route', () => {
    for (const key of ['licence_key', 'linked_account']) {
      const r = schema.safeParse({ [key]: 'hunter2' });
      expect(r.success, key).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/secrets route/);
    }
  });
});
