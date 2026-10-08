import { TOOL_DEFS, type ToolName } from '@kept/mcp';
import { describe, expect, it } from 'vitest';
import { compactSchema, toolSpecOf } from './prompt.js';

const NAMES = Object.keys(TOOL_DEFS) as ToolName[];
const sizeOf = (opts: { oneLocation?: boolean } = {}) =>
  JSON.stringify(NAMES.map((n) => toolSpecOf(n, opts).inputSchema)).length;

describe('the tools as the model sees them', () => {
  it('leave out $schema and long patterns, and keep formats and short patterns', () => {
    expect(
      compactSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', pattern: `^${'[0-9a-f]'.repeat(10)}$` },
          code: { type: 'string', pattern: '^[0-9A-Z]{6}$' },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        code: { type: 'string', pattern: '^[0-9A-Z]{6}$' },
      },
    });
    for (const n of NAMES) {
      const s = JSON.stringify(toolSpecOf(n).inputSchema);
      expect(s).not.toContain('$schema');
    }
  });

  it('with one location, offer no optional location_id; a required one stays', () => {
    for (const n of NAMES) {
      const full = toolSpecOf(n).inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const one = toolSpecOf(n, { oneLocation: true }).inputSchema as typeof full;
      const required = full.required?.includes('location_id') ?? false;
      expect(Object.hasOwn(one.properties ?? {}, 'location_id')).toBe(
        required && Object.hasOwn(full.properties ?? {}, 'location_id'),
      );
    }
  });

  it('fit a free-tier plan: every tool together is well under 20,000 characters for one location', () => {
    // A request carries every tool; Groq's free tier allowed 8,000 tokens a minute for
    // openai/gpt-oss-120b, counting the output allowance too (2026-10-07: 9,571 asked).
    expect(sizeOf({ oneLocation: true })).toBeLessThan(15_000);
    expect(sizeOf()).toBeLessThan(20_000);
  });

  it('still validate with the full contract', () => {
    const spec = toolSpecOf('where_is' as ToolName, { oneLocation: true });
    expect(spec.validate?.({ location_id: 'not-a-uuid', query: 'drill' }).success).toBe(false);
  });
});
