import type { Part } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import type { KeptMessage } from '../ai/convert.js';
import { fitToCeiling, TRIMMED } from './fit.js';

// 1.4.1: a request sized under the provider's per-minute token limit (Groq free: 8,000) instead of
// sent and refused with a 413. `measure` here counts characters, so the cases read plainly.

const result = (callId: string, size: number): KeptMessage => ({
  role: 'tool',
  parts: [
    {
      type: 'tool_result',
      callId,
      tool: 'search_things',
      locationIds: [],
      output: { items: 'x'.repeat(size) },
    } as Part,
  ],
});
const user = (text: string): KeptMessage => ({ role: 'user', parts: [{ type: 'text', text }] });
const measure = (messages: readonly KeptMessage[], maxOut: number) =>
  JSON.stringify(messages).length + maxOut;

describe('fitting a request under the ceiling', () => {
  it('leaves a request that fits alone', () => {
    const messages = [user('where is the drill?')];
    expect(fitToCeiling({ messages, maxOut: 1200, floor: 400, ceiling: 10_000, measure })).toEqual({
      messages,
      maxOut: 1200,
      trimmed: 0,
    });
  });

  it('first lowers the output allowance, never below the floor', () => {
    const messages = [user('a'.repeat(900))];
    const size = measure(messages, 0);
    const fitted = fitToCeiling({
      messages,
      maxOut: 1200,
      floor: 400,
      ceiling: Math.ceil((size + 700) / 0.95),
      measure,
    });
    expect(fitted?.trimmed).toBe(0);
    expect(fitted?.maxOut).toBeGreaterThanOrEqual(400);
    expect(fitted?.maxOut).toBeLessThan(1200);
  });

  it('then shortens the oldest tool results, keeping the newest whole when it can', () => {
    const messages = [user('q'), result('c1', 4000), result('c2', 4000), result('c3', 1000)];
    const fitted = fitToCeiling({ messages, maxOut: 1200, floor: 400, ceiling: 7000, measure });
    expect(fitted).not.toBeNull();
    const outputs = fitted?.messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === 'tool_result' ? [p.output] : [])),
    );
    expect(outputs?.[0]).toEqual(TRIMMED);
    expect(outputs?.[2]).toEqual({ items: 'x'.repeat(1000) });
    expect(fitted?.trimmed).toBeGreaterThan(0);
    expect(measure(fitted?.messages ?? [], fitted?.maxOut ?? 0)).toBeLessThanOrEqual(7000 * 0.95);
    // The stored conversation is not changed.
    expect(messages[1]?.parts[0]).toMatchObject({ output: { items: 'x'.repeat(4000) } });
  });

  it('answers null when even trimmed it can not fit', () => {
    const messages = [user('q'.repeat(9000))];
    expect(fitToCeiling({ messages, maxOut: 1200, floor: 400, ceiling: 5000, measure })).toBeNull();
  });
});
