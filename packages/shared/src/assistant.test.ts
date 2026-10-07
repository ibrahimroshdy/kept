import { describe, expect, it } from 'vitest';
import {
  CONTEXT_KINDS,
  canonicalJson,
  isLiveTurn,
  PART_TYPES,
  PROPOSAL_STATUS,
  PROPOSAL_TTL_MS,
  THREAD_RETENTION_DAYS,
  TURN_LIMITS,
  TURN_STATUSES,
} from './assistant.js';

describe('assistant contracts', () => {
  it('holds the plan’s limits (Q4, Q21) and lifetimes (D22, D23)', () => {
    expect(TURN_LIMITS).toEqual({
      maxSteps: 6,
      maxToolCallsPerStep: 4,
      turnTimeoutMs: 180_000,
      maxQuestionChars: 2000,
      historyMessages: 20,
    });
    expect(Object.isFrozen(TURN_LIMITS)).toBe(true);
    expect(PROPOSAL_TTL_MS).toBe(10 * 60 * 1000);
    expect(THREAD_RETENTION_DAYS).toBe(90);
  });

  it('lists the context kinds, part types and statuses', () => {
    expect(CONTEXT_KINDS).toEqual(['location', 'place', 'thing', 'search', 'inbox', 'none']);
    expect(PART_TYPES).toContain('reasoning');
    expect(PART_TYPES).toContain('redacted');
    expect(PROPOSAL_STATUS).toEqual([
      'open',
      'confirmed',
      'cancelled',
      'expired',
      'conflict',
      'failed',
    ]);
    expect(TURN_STATUSES.filter(isLiveTurn)).toEqual(['queued', 'running', 'waiting_provider']);
  });

  it('writes canonical JSON: keys sorted at every depth, arrays kept in order', () => {
    const a = { thing_id: 'K7D2QX', to: { b: 1, a: [{ y: 2, x: 1 }] } };
    const b = { to: { a: [{ x: 1, y: 2 }], b: 1 }, thing_id: 'K7D2QX' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"thing_id":"K7D2QX","to":{"a":[{"x":1,"y":2}],"b":1}}');
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });
});
