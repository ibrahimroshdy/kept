/**
 * Leaving Kept for another site (an OAuth client's redirect, an OIDC provider's sign-in page):
 * the browser goes there itself, not the router. One object, so tests can watch it instead of
 * jsdom's unconfigurable `location.assign`.
 */
export const leave = {
  to(url: string): void {
    window.location.assign(url);
  },
};
