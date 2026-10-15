import { describe, expect, it } from 'vitest';
import { HINT_KEYS, isHintKey, TOUR_SECTION_IDS, tourProgressKey } from './hints.js';

describe('HINT_KEYS (D138)', () => {
  it('fit the user_hints key CHECK', () => {
    for (const key of HINT_KEYS) expect(key).toMatch(/^[a-z0-9_.:-]{1,64}$/);
    expect(new Set(HINT_KEYS).size).toBe(HINT_KEYS.length);
  });

  it('include the key step 2’s Home reads', () => {
    expect(isHintKey('installed_standalone')).toBe(true);
    expect(isHintKey('capture.mode_strip')).toBe(true);
    expect(isHintKey('nope')).toBe(false);
  });

  it('hold one progress key per tour section (D242)', () => {
    for (const id of TOUR_SECTION_IDS) expect(isHintKey(tourProgressKey(id))).toBe(true);
    expect(isHintKey('help.tour.vehicles')).toBe(false);
  });
});
