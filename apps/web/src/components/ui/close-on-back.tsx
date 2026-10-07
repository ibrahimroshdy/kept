/**
 * Back closes the top sheet first, then goes back in history (screens §1, "Back"): Android's back
 * gesture and the browser's Back button. Rendered inside a React Aria modal (the sheets, dialogs
 * and the ⌘K palette), where the modal's overlay state is in context.
 *
 * While the modal is open it holds one history entry of its own: the same address, with its depth
 * in `history.state`. Back pops that entry and this closes the modal, the topmost first when
 * sheets are stacked. Closed any other way (Escape, Done, a tap outside), the modal takes its
 * entry back off, unless the page has navigated since, so Back never needs pressing twice.
 *
 * The entry keeps the router's own state (TanStack's index and key), so the router reads the pop
 * as a move to the same location and changes nothing. (UI audit 2026-09-29.)
 */
import { useContext, useEffect, useRef } from 'react';
import { OverlayTriggerStateContext } from 'react-aria-components';

const KEY = 'keptSheet';
/** How many modals hold an entry now. */
let depth = 0;

const depthOf = (state: unknown): number => {
  const d = (state as Record<string, unknown> | null)?.[KEY];
  return typeof d === 'number' ? d : 0;
};

export function CloseOnBack() {
  const overlay = useContext(OverlayTriggerStateContext);
  const close = useRef(overlay?.close);
  close.current = overlay?.close;
  const present = !!overlay;

  useEffect(() => {
    if (!present) return;
    const mine = ++depth;
    const href = window.location.href;
    window.history.pushState({ ...(window.history.state ?? {}), [KEY]: mine }, '');
    let popped = false;
    const onPop = (e: PopStateEvent) => {
      if (depthOf(e.state) >= mine) return;
      popped = true;
      close.current?.();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      depth = mine - 1;
      if (popped) return;
      // After the router has written any navigation the closing started (it writes on a
      // microtask): only an entry still ours, at the same address, is taken back off.
      setTimeout(() => {
        if (depthOf(window.history.state) === mine && window.location.href === href)
          window.history.back();
      }, 0);
    };
  }, [present]);

  return null;
}
