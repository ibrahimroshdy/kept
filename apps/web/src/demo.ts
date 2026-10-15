/**
 * Demo mode, for screenshots and for looking at screens before the server routes exist.
 * `?demo=owner|firstrun|member|setup|signedout` (or `?demo=1` for owner) swaps `fetch` for the
 * in-memory mock server with that scenario. `&lang=en|ar|fr|de|it`, `&theme=light|dark` and
 * `&digits=western|eastern` set the display preferences for the visit. `&showcase=1` is the demo
 * as the docs site's screenshots show it (scripts/capture-screens.mjs): Home's AI cap not reached,
 * so no screen says "AI paused" (`withinAiCap`). The scenario and the showcase survive in-app
 * navigation (sessionStorage), so a reload keeps them.
 *
 * Only reachable from main.tsx behind a compile-time flag: never in a production bundle.
 */

import { withinAiCap } from '@/api/capture/mock/state';
import { type MockState, type ScenarioName, scenarios } from '@/api/mock/fixtures';
import { createMockApi } from '@/api/mock/server';
import { DIGITS_KEY, LOCALE_KEY, setDigits, setThemePref, THEME_KEY } from '@/lib/prefs';

const KEY = 'kept.demo';
const SHOWCASE_KEY = 'kept.demo.showcase';

export function installDemo(): void {
  const params = new URLSearchParams(location.search);
  let name = params.get('demo');
  let showcase = params.get('showcase') === '1';
  try {
    if (name) {
      sessionStorage.setItem(KEY, name);
      if (showcase) sessionStorage.setItem(SHOWCASE_KEY, '1');
      else sessionStorage.removeItem(SHOWCASE_KEY);
    } else {
      name = sessionStorage.getItem(KEY);
      showcase = sessionStorage.getItem(SHOWCASE_KEY) === '1';
    }
  } catch {
    // No storage: the demo lasts for this page load.
  }
  if (!name) return;
  const scenario: ScenarioName = name in scenarios ? (name as ScenarioName) : 'owner';
  const set = (key: string, value: string | null) => {
    if (!value) return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore.
    }
  };
  set(LOCALE_KEY, params.get('lang'));
  set(THEME_KEY, params.get('theme'));
  set(DIGITS_KEY, params.get('digits'));
  // prefs.ts read storage when it loaded, before this ran: tell it directly too.
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') setThemePref(theme);
  const digits = params.get('digits');
  if (digits === 'western' || digits === 'eastern') setDigits(digits);
  const state = scenarios[scenario]();
  if (showcase) withinAiCap(state.capture);
  if ((params.get('lang') ?? localStorageLang()) === 'ar') arabise(state);
  const mock = createMockApi(state);
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, location.origin).pathname;
    if (path.startsWith('/api/') || path === '/version') return mock.fetch(input, init);
    return realFetch(input, init);
  };
  console.info(`[kept] demo mode: ${scenario}`);
}

function localStorageLang(): string | null {
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

/** The same household as the Arabic frames on the screens board. Data, so not in the catalog. */
const AR: Record<string, string> = {
  Home: 'المنزل',
  Garage: 'المرآب',
  Ibrahim: 'إبراهيم',
  Bruce: 'بروس',
  Alfred: 'ألفريد',
  Louis: 'لويس',
  Peter: 'بيتر',
  Talia: 'تاليا',
  Antar: 'عنتر',
};
const ar = (v: string) => AR[v] ?? v;

function arabise(s: MockState): void {
  s.me.user.displayName = ar(s.me.user.displayName);
  for (const l of s.locations) l.name = ar(l.name);
  for (const entry of Object.values(s.members)) {
    for (const m of entry.members) {
      m.displayName = ar(m.displayName);
      if (m.managedByName) m.managedByName = ar(m.managedByName);
    }
    for (const i of entry.invites) if (i.createdByName) i.createdByName = ar(i.createdByName);
  }
  for (const inv of Object.values(s.invites)) {
    inv.location.name = ar(inv.location.name);
    inv.inviterName = ar(inv.inviterName);
  }
  for (const u of s.admin.users) u.displayName = ar(u.displayName);
}
