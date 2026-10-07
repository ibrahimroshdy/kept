import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  byteLength,
  decodeOffsetCursor,
  encodeOffsetCursor,
  envelopeSchema,
  fit,
  isToolError,
  OUTPUT_LIMIT_BYTES,
  ok,
  PAGE,
  pageSize,
  toolError,
} from './output.js';

const AS_OF = new Date('2026-09-30T10:00:00Z');
const thing = (i: number, notes = '') => ({
  id: `0192a1b2-0000-7000-8000-${String(i).padStart(12, '0')}`,
  short_code: 'K7D2QX',
  untrusted: { name: `HDMI cable ${i}`, path: ['Home', 'Office', 'Drawer'], notes },
});

describe('page and cursor', () => {
  it('pages 20 by default, at most 200', () => {
    expect(PAGE).toEqual({ default: 20, max: 200 });
    expect(pageSize(undefined)).toBe(20);
    expect(pageSize(5)).toBe(5);
    expect(pageSize(0)).toBe(1);
    expect(pageSize(1000)).toBe(200);
    expect(pageSize(Number.NaN)).toBe(20);
  });

  it('round-trips an offset cursor and refuses anything else', () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(40))).toBe(40);
    expect(decodeOffsetCursor('not a cursor!')).toBeNull();
    expect(decodeOffsetCursor(btoa('x:1'))).toBeNull();
  });
});

describe('fit', () => {
  it.each([
    ['a small list', 3, '', false],
    ['a list over the limit', 200, '', true],
  ])('%s', (_name, count, notes, shortened) => {
    const env = ok({ items: Array.from({ length: count }, (_, i) => thing(i, notes)) }, AS_OF);
    const out = fit(env);
    expect(isToolError(out)).toBe(false);
    expect(byteLength(out)).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
    if (isToolError(out)) return;
    const items = (out.data as { items: unknown[] }).items;
    if (shortened) {
      expect(items.length).toBeLessThan(count);
      expect(items.length).toBeGreaterThan(1);
      expect(decodeOffsetCursor(out.next_cursor ?? '')).toBe(items.length);
      // the largest count that fits: one more would not
      const more = { ...out, data: { items: env.data.items.slice(0, items.length + 1) } };
      expect(byteLength(more)).toBeGreaterThan(OUTPUT_LIMIT_BYTES);
    } else {
      expect(out).toBe(env);
    }
  });

  it('continues the page’s offset, or uses the caller’s cursor', () => {
    const env = ok({ items: Array.from({ length: 200 }, (_, i) => thing(i)) }, AS_OF);
    const a = fit(env, { offset: 40 });
    if (isToolError(a)) throw new Error('fitted');
    expect(decodeOffsetCursor(a.next_cursor ?? '')).toBe(40 + (a.data.items as unknown[]).length);
    const b = fit(env, { cursorAt: (n) => `after-${n}` });
    if (isToolError(b)) throw new Error('fitted');
    expect(b.next_cursor).toBe(`after-${(b.data.items as unknown[]).length}`);
  });

  it('trims a single oversized item field by field, never cutting a string', () => {
    const big = { ...thing(1), untrusted: { ...thing(1).untrusted, notes: 'n'.repeat(9000) } };
    const out = fit(ok({ items: [big] }, AS_OF));
    if (isToolError(out)) throw new Error('fitted');
    expect(out.trimmed).toEqual(['items[0].untrusted.notes']);
    const kept = (out.data as { items: (typeof big)[] }).items[0];
    expect(kept?.id).toBe(big.id);
    expect(kept?.untrusted.name).toBe(big.untrusted.name);
    expect(kept?.untrusted).not.toHaveProperty('notes');
    expect(byteLength(out)).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
  });

  it('removes the largest fields first and keeps ids, short IDs and names', () => {
    const data = {
      thing: {
        id: 'x',
        short_code: 'K7D2QX',
        untrusted: { name: 'Drill', notes: 'a'.repeat(5000), fields: { manual: 'b'.repeat(4000) } },
      },
    };
    const out = fit(ok(data, AS_OF));
    if (isToolError(out)) throw new Error('fitted');
    expect(out.trimmed).toEqual(['thing.untrusted.notes']);
    expect(out.data.thing.untrusted.fields.manual).toHaveLength(4000);
  });

  it('answers output_too_large when only protected fields are left', () => {
    const out = fit(ok({ items: [{ id: 'x', name: 'n'.repeat(9000) }] }, AS_OF));
    expect(out).toEqual({
      error: 'output_too_large',
      hint: 'Ask for fewer items or a narrower query.',
    });
  });

  it('passes errors through', () => {
    const e = toolError('tool_unavailable', 'Call capabilities.');
    expect(fit(e)).toBe(e);
  });
});

describe('envelopeSchema', () => {
  it('accepts {data, as_of, next_cursor?} and {error, hint}', () => {
    const s = envelopeSchema(z.object({ n: z.number() }));
    expect(s.safeParse(ok({ n: 1 }, AS_OF, 'c')).success).toBe(true);
    expect(s.safeParse(toolError('forbidden', 'Ask an admin.')).success).toBe(true);
    expect(s.safeParse({ data: { n: 1 } }).success).toBe(false);
    expect(ok({ n: 1 }, AS_OF)).toEqual({ data: { n: 1 }, as_of: '2026-09-30T10:00:00.000Z' });
  });
});
