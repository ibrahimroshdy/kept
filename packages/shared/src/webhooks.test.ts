import { describe, expect, it } from 'vitest';
import {
  formatSignature,
  parseSignature,
  SIGNATURE_HEADER,
  signedContent,
  WEBHOOK_EVENT_ID,
  WEBHOOK_EVENTS,
  WEBHOOK_LIMITS,
} from './webhooks.js';

describe('webhooks', () => {
  it('holds the §2.6 events and limits', () => {
    expect(WEBHOOK_EVENTS).toEqual([
      'thing.created',
      'thing.updated',
      'thing.moved',
      'thing.trashed',
      'thing.restored',
      'thing.lifecycle_changed',
      'reading.logged',
      'reminder.due',
    ]);
    expect(WEBHOOK_LIMITS).toEqual({ attempts: 10, windowHours: 24, perSecondPerLocation: 10 });
    expect(SIGNATURE_HEADER).toBe('Kept-Signature');
  });

  it('formats and parses the signature header', () => {
    const mac = 'ab'.repeat(32);
    const header = formatSignature(1790000000, mac);
    expect(header).toBe(`t=1790000000,v1=${mac}`);
    expect(parseSignature(header)).toEqual({ t: 1790000000, v1: mac });
    expect(parseSignature('t=1,v1=zz')).toBeNull();
    expect(parseSignature(`v1=${mac},t=1`)).toBeNull();
    expect(signedContent(12, '{"a":1}')).toBe('12.{"a":1}');
  });

  it('checks event ids', () => {
    expect(WEBHOOK_EVENT_ID.test('evt_01J2ABCDEF')).toBe(true);
    expect(WEBHOOK_EVENT_ID.test('evt_short')).toBe(false);
  });
});
