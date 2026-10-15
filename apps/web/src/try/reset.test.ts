/** Try Kept (D246): each visit and Reset start from the same household; display prefs stay. */
import { describe, expect, it, vi } from 'vitest';
import { forgetHousehold, forgetHouseholdHere, resetTry } from './reset';

function fill(storage: Storage) {
  storage.clear();
  for (const [k, v] of Object.entries({
    'kept.theme': 'dark',
    'kept.locale': 'ar',
    'kept.digits': 'eastern',
    'kept.width': 'full',
    'kept.sidebar': 'collapsed',
    'kept.map.quality': 'low',
    'kept.getStarted.hidden': '1',
    'kept.recentPlaces': '[]',
    'kept.search.recent.u1': '["cable"]',
    'kept.offline.user': 'u1',
    'starlight-theme': 'dark',
  }))
    storage.setItem(k, v);
}

describe('forgetHousehold', () => {
  it("removes the household's keys and keeps the display preferences and the docs site's", () => {
    fill(localStorage);
    forgetHousehold(localStorage);
    expect(Object.keys(localStorage).sort()).toEqual([
      'kept.digits',
      'kept.locale',
      'kept.map.quality',
      'kept.sidebar',
      'kept.theme',
      'kept.width',
      'starlight-theme',
    ]);
  });

  it('clears both storages and survives one that throws', () => {
    fill(localStorage);
    sessionStorage.setItem('kept.demo', 'owner');
    forgetHouseholdHere(window);
    expect(localStorage.getItem('kept.recentPlaces')).toBeNull();
    expect(sessionStorage.getItem('kept.demo')).toBeNull();
    const blocked = {
      get localStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError');
      },
      get sessionStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    expect(() => forgetHouseholdHere(blocked)).not.toThrow();
  });
});

describe('resetTry', () => {
  it('goes back to Home under the base and reloads', () => {
    fill(localStorage);
    const replaceState = vi.fn();
    const reload = vi.fn();
    resetTry(
      {
        localStorage,
        sessionStorage,
        history: { replaceState } as unknown as History,
        location: { reload } as unknown as Location,
      },
      '/try/kept/app/',
    );
    expect(replaceState).toHaveBeenCalledWith(null, '', '/try/kept/app/#/');
    expect(reload).toHaveBeenCalledOnce();
    expect(localStorage.getItem('kept.getStarted.hidden')).toBeNull();
    expect(localStorage.getItem('kept.theme')).toBe('dark');
  });
});
