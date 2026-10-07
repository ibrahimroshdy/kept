/**
 * Media queries as React state: the phone/desktop line and the installed-app check. jsdom has
 * no `matchMedia`, so every read is guarded and falls back to "no match" (the phone layout).
 */
import { useEffect, useState } from 'react';

/** The app's phone/desktop line: the sidebar appears at `md` (768px). */
export const WIDE = '(min-width: 768px)';

/**
 * Where the assistant's panel docks beside the page (UI review steps 6–8, H1): from 1280 px, with
 * the sidebar as its icon rail, the page keeps the width its `lg:` layouts expect (816 px). From
 * 768 to 1279 px the panel floats over the page's end instead, and the page keeps its layout.
 */
export const DOCKED = '(min-width: 1280px)';

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Whether `query` matches now, following changes (a rotated tablet, a resized window). */
export function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(query);
    } catch {
      return;
    }
    const sync = () => setOn(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, [query]);
  return on;
}

/**
 * Kept was opened as the installed app (screens §8: "Install on your phone" completes in
 * standalone display mode). iOS Safari also reports it as `navigator.standalone`.
 */
export function isStandalone(): boolean {
  if (matches('(display-mode: standalone)')) return true;
  try {
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}
