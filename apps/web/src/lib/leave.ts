/**
 * Leaving Kept for another site (an OAuth client's redirect, an OIDC provider's sign-in page):
 * the browser goes there itself, not the router. One object, so tests can watch it instead of
 * jsdom's unconfigurable `location.assign`.
 */
import { TRY } from '@/try/flag';
import { leavingIsOff } from '@/try/off';

export const leave = {
  to(url: string): void {
    // Try Kept (D246) never leaves for another host: it says so instead (try/off.ts).
    if (TRY) {
      leavingIsOff();
      return;
    }
    window.location.assign(url);
  },
};
