/**
 * Whether the browser says it has a connection (`navigator.onLine`), following the `online` and
 * `offline` events. It can say "online" on a network that reaches nothing; a request that fails
 * then answers ApiError `offline`, which screens treat the same way. Screens use it to disable
 * what needs the server, with the reason "Needs a connection" (screens §3).
 */
import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

const snapshot = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
