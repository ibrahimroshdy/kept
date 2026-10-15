/**
 * Try Kept's sample household (D246) lives in this tab's memory (src/demo.ts): a reload brings
 * the scenario back. What the app keeps in the browser about the household (the Get started
 * card hidden, recent places and searches, the last capture target, folded groups, the label
 * stock) goes too, at every start and on Reset, so each visit starts from the same household.
 * The display preferences stay (theme, language, digits, width, the sidebar, the map's detailed
 * models): they are the visitor's, not the household's.
 */
import { DIGITS_KEY, LOCALE_KEY, SIDEBAR_KEY, THEME_KEY, WIDTH_KEY } from '@/lib/prefs';
import { appBase } from './flag';

const KEEP = new Set([
  THEME_KEY,
  LOCALE_KEY,
  DIGITS_KEY,
  WIDTH_KEY,
  SIDEBAR_KEY,
  'kept.map.quality',
]);

/** Removes every `kept.*` key except the display preferences. */
export function forgetHousehold(storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith('kept.') && !KEEP.has(key)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

/** Both storages, where the browser allows them. */
export function forgetHouseholdHere(win: Pick<Window, 'localStorage' | 'sessionStorage'>): void {
  for (const get of [() => win.localStorage, () => win.sessionStorage]) {
    try {
      forgetHousehold(get());
    } catch {
      // Storage blocked: nothing was kept there either.
    }
  }
}

/** Reset: back to Home with the sample household as it started. */
export function resetTry(
  win: Pick<Window, 'localStorage' | 'sessionStorage' | 'history' | 'location'> = window,
  base: string = appBase(),
): void {
  forgetHouseholdHere(win);
  win.history.replaceState(null, '', `${base}#/`);
  win.location.reload();
}
