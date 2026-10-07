import { describe, expect, it } from 'vitest';
import {
  BUILTIN_FIELD_GROUPS,
  BUILTIN_TYPES,
  builtinTypeChain,
  resolveCapabilities,
  resolveDefaultMeter,
} from './builtin-types.js';
import { CAPABILITIES, FIELD_KINDS } from './inventory.js';
import { resolveFields } from './type-fields.js';

const KEY = /^[a-z][a-z0-9_]*$/;
const ICON = /^(lucide|tabler|kept):[a-z0-9]+(-[a-z0-9]+)*$/;
const TYPES = BUILTIN_TYPES.filter((t) => !t.isFieldGroup);

describe('BUILTIN_TYPES (D154, D192)', () => {
  it('has unique, well-formed keys', () => {
    const keys = BUILTIN_TYPES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(KEY);
  });

  it('every parent exists, is a type (not a group), and there are no cycles', () => {
    for (const t of BUILTIN_TYPES) {
      if (t.parent === undefined) continue;
      const parent = BUILTIN_TYPES.find((p) => p.key === t.parent);
      expect(parent, `${t.key} → ${t.parent}`).toBeDefined();
      expect(parent?.isFieldGroup).toBeFalsy();
    }
    for (const t of BUILTIN_TYPES) expect(() => builtinTypeChain(t.key)).not.toThrow();
  });

  it('field groups stand alone: no parent, no groups of their own, no children', () => {
    for (const g of BUILTIN_FIELD_GROUPS.values()) {
      expect(g.parent).toBeUndefined();
      expect(g.groups).toBeUndefined();
      expect(BUILTIN_TYPES.some((t) => t.parent === g.key)).toBe(false);
    }
  });

  it('every referenced group exists and is a field group', () => {
    for (const t of BUILTIN_TYPES) {
      for (const g of t.groups ?? [])
        expect(BUILTIN_FIELD_GROUPS.has(g), `${t.key}: ${g}`).toBe(true);
    }
  });

  it('D192: TV/display, phone, tablet, computer and network device share the Device group', () => {
    const withDevice = TYPES.filter((t) => t.groups?.includes('device')).map((t) => t.key);
    expect(withDevice.sort()).toEqual(
      ['computer', 'network_device', 'phone', 'tablet', 'tv_display'].sort(),
    );
  });

  it('no field key is redefined along any chain or group', () => {
    for (const t of TYPES) {
      expect(
        () => resolveFields(builtinTypeChain(t.key), BUILTIN_FIELD_GROUPS),
        t.key,
      ).not.toThrow();
    }
  });

  it('every type and field has an English and an Arabic name', () => {
    for (const t of BUILTIN_TYPES) {
      expect(t.names.en.trim(), t.key).not.toBe('');
      expect(t.names.ar, t.key).toMatch(/\p{Script=Arabic}/u);
      for (const f of t.fields) {
        expect(f.names.en.trim(), `${t.key}.${f.key}`).not.toBe('');
        expect(f.names.ar, `${t.key}.${f.key}`).toMatch(/\p{Script=Arabic}/u);
      }
    }
  });

  it('fields are well-formed: known kinds, units on numbers only, options on selects', () => {
    for (const t of BUILTIN_TYPES) {
      for (const f of t.fields) {
        const where = `${t.key}.${f.key}`;
        expect(f.key, where).toMatch(KEY);
        expect(FIELD_KINDS, where).toContain(f.kind);
        if (f.unit !== undefined) expect(f.kind, where).toBe('number');
        if (f.kind === 'select' || f.kind === 'multi_select')
          expect(f.options?.length).toBeGreaterThan(0);
        if (f.secret) expect(f.kind, where).toBe('text');
      }
    }
  });

  it('exactly the D154/D192 fields are secret', () => {
    const secret = BUILTIN_TYPES.flatMap((t) =>
      t.fields.filter((f) => f.secret).map((f) => `${t.key}.${f.key}`),
    );
    expect(secret.sort()).toEqual(
      [
        'computer.licence_key',
        'device.linked_account',
        'network_device.wifi_password',
        'safe.combination',
      ].sort(),
    );
  });

  it('icons use the lucide:/tabler:/kept: form, and capabilities are known', () => {
    for (const t of BUILTIN_TYPES) {
      expect(t.icon, t.key).toMatch(ICON);
      for (const c of t.capabilities) expect(CAPABILITIES).toContain(c);
    }
  });

  it('capabilities inherit down the tree (D154)', () => {
    expect(resolveCapabilities(builtinTypeChain('phone'))).toEqual(['warranty', 'serialized']);
    expect(resolveCapabilities(builtinTypeChain('car'))).toEqual([
      'container',
      'metered',
      'warranty',
      'serialized',
    ]);
    expect(resolveCapabilities(builtinTypeChain('fire_extinguisher'))).toEqual(['expires']);
    expect(resolveCapabilities(builtinTypeChain('child_car_seat'))).toEqual([
      'serialized',
      'expires',
    ]);
    expect(resolveCapabilities(builtinTypeChain('box_bin'))).toEqual(['container']);
    expect(resolveCapabilities(builtinTypeChain('batteries'))).toEqual(['consumable']);
  });

  it('default meters: vehicles in km, generators in hours, bicycles none', () => {
    expect(resolveDefaultMeter(builtinTypeChain('car'))).toEqual({ kind: 'distance', unit: 'km' });
    expect(resolveDefaultMeter(builtinTypeChain('generator'))).toEqual({
      kind: 'hours',
      unit: 'h',
    });
    expect(resolveDefaultMeter(builtinTypeChain('bicycle'))).toBeNull();
    expect(resolveDefaultMeter(builtinTypeChain('phone'))).toBeNull();
  });

  it('builtinTypeChain is root first, and throws on an unknown key', () => {
    expect(builtinTypeChain('power_tool').map((t) => t.key)).toEqual(['tool', 'power_tool']);
    expect(() => builtinTypeChain('nope')).toThrow(/unknown/);
  });
});
