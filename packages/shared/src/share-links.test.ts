import { describe, expect, it } from 'vitest';
import { SHARE_LINK_DEFAULT_DAYS, SHARE_LINK_EXPIRY_DAYS, shareViewOf } from './share-links.js';

describe('shareViewOf', () => {
  it('keeps the words, places, types and tags, and the one location', () => {
    expect(
      shareViewOf({
        q: '  drill ',
        filters: { location: ['L1'], place: ['P1', 'P2'], tag: ['T1'], type: [] },
        not: ['tag'],
      }),
    ).toEqual({
      view: { q: 'drill', filters: { place: ['P1', 'P2'], tag: ['T1'] }, not: ['tag'] },
      locationId: 'L1',
      unsupported: [],
    });
  });

  it('names what a link can not keep: state, price, several locations or none of one', () => {
    expect(
      shareViewOf({ filters: { state: ['lent'], priceMin: ['10'], location: ['L1', 'L2'] } })
        .unsupported,
    ).toEqual(['location', 'priceMin', 'state']);
    const none = shareViewOf({ filters: { location: ['L1'] }, not: ['location'] });
    expect(none.locationId).toBeNull();
    expect(none.unsupported).toEqual(['location']);
  });

  it('is an empty list with no criteria', () => {
    expect(shareViewOf({})).toEqual({ view: {}, locationId: null, unsupported: [] });
  });

  it('offers the default among the expiry choices, a year at most', () => {
    expect(SHARE_LINK_EXPIRY_DAYS).toContain(SHARE_LINK_DEFAULT_DAYS);
    expect(Math.max(...SHARE_LINK_EXPIRY_DAYS)).toBe(365);
  });
});
