import { CAPTURE_MODES } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { WIRE_IN_USE, wireSchema } from './wire.js';

// biome-ignore lint/suspicious/noExplicitAny: a JSON Schema walked by path in assertions
type Json = any;

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
  } else if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    for (const v of Object.values(node)) walk(v, visit);
  }
}

describe('wireSchema (spike finding 1)', () => {
  it.each(CAPTURE_MODES)('%s (simple): no tuples, formats, patterns or propertyNames', (mode) => {
    const s = wireSchema(mode, 'simple');
    walk(s, (n) => {
      expect(n).not.toHaveProperty('pattern');
      expect(n).not.toHaveProperty('format');
      expect(n).not.toHaveProperty('propertyNames');
      expect(n).not.toHaveProperty('$schema');
      if ('items' in n) expect(Array.isArray(n.items)).toBe(false);
    });
    expect(s.type).toBe('object');
  });

  it('turns the bbox tuple into a fixed-length number array', () => {
    const thing = wireSchema('thing') as Json;
    expect(thing.properties.objects.items.properties.bbox).toEqual({
      type: 'array',
      items: { type: 'number', minimum: 0, maximum: 1 },
      minItems: 4,
      maxItems: 4,
    });
  });

  it('describes dates in words and keeps aliases an object of string lists', () => {
    const receipt = wireSchema('receipt', 'simple') as Json;
    expect(receipt.properties.date.properties.value).toEqual({
      type: 'string',
      description: 'A date, YYYY-MM-DD',
    });
    const aliases = (wireSchema('thing') as Json).properties.objects.items.properties.aliases;
    expect(aliases.type).toBe('object');
    expect(aliases.additionalProperties.type).toBe('array');
  });

  it('keeps which fields are required', () => {
    expect((wireSchema('reading') as Json).required).toEqual(['value']);
    expect((wireSchema('receipt', 'simple') as Json).required).toEqual(['lines']);
  });
});

describe('wireSchema variants (T11 follow-up)', () => {
  it("receipt-required: the receipt's date and currency required, and a short date pattern", () => {
    const s = wireSchema('receipt', 'receipt-required') as Json;
    expect(s.required).toEqual(['lines', 'date', 'currency']);
    expect(s.properties.date.properties.value).toEqual({
      type: 'string',
      description: 'A date, YYYY-MM-DD',
      pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
    });
    // Nothing else changes, and the simple form is untouched.
    expect(s.properties.currency).toEqual(
      (wireSchema('receipt', 'simple') as Json).properties.currency,
    );
    expect(JSON.stringify(wireSchema('receipt', 'simple'))).not.toContain('pattern');
    // The only pattern is the date's: nothing like zod's long regex or a format.
    walk(s, (n) => {
      expect(n).not.toHaveProperty('format');
      if ('pattern' in n) expect(n.pattern).toBe('^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
    });
  });

  it('other modes are sent as simple under any variant', () => {
    for (const mode of CAPTURE_MODES.filter((m) => m !== 'receipt'))
      expect(wireSchema(mode, 'receipt-required')).toEqual(wireSchema(mode, 'simple'));
  });

  it('the worker sends receipt-required (docs/evals/2026-09-29-groq-receipt-date-currency.md)', () => {
    expect(WIRE_IN_USE).toBe('receipt-required');
  });
});
