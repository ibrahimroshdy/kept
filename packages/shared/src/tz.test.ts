import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('runs with TZ pinned to Africa/Cairo (vitest test.env)', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Africa/Cairo');
    expect(new Date('2026-01-15T12:00:00Z').getTimezoneOffset()).toBe(-120);
  });
});
